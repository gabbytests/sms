import 'dotenv/config';
import express from 'express';
import admin from 'firebase-admin';
import fetch from 'node-fetch';
import fs from 'fs';

const app = express();
app.use(express.json());

// 🔐 Initialize Firebase Admin
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// 📩 Send SMS via Hubtel
async function sendHubtelSMS(to, message) {
  try {
    const auth = Buffer.from(
      `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
    ).toString('base64');

    const body = {
      From: 'Hubtel', // must be approved
      To: to,
      Content: message,
    };

    const response = await fetch('https://smsc.hubtel.com/v1/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log('📨 Hubtel response:', response.status, text);

    if (!response.ok) {
      console.error('❌ Hubtel rejected SMS');
    } else {
      console.log('✅ SMS sent to:', to);
    }
  } catch (err) {
    console.error('🔥 Hubtel fetch error:', err);
  }
}


// 🔔 Listen for new orders
let unsubscribeOrders = null;

function startOrderListener() {
  if (unsubscribeOrders) unsubscribeOrders();
  console.log('📡 Firestore order listener started...');

  try {
    unsubscribeOrders = db
      .collection("orders")
      .where("status", "==", "pending")
      .where("smsSent", "==", false)
      .onSnapshot(
        (snapshot) => {
          snapshot.docChanges().forEach(async (change) => {
            if (change.type === "added") {
              const order = change.doc.data();
              const orderId = change.doc.id;

              console.log(`🆕 New pending order detected: ${orderId}`);

              const delivery = order.deliveryDetails || {};
              const cart = Array.isArray(order.cart)
                ? order.cart
                : Array.isArray(order.cartItems)
                ? order.cartItems
                : [];

              const cartSummary = cart
                .map((item) => {
                  const name = item.name || "Unnamed Item";
                  const qty = item.quantity ?? 1;
                  const size = item.size ? ` (${item.size})` : "";
                  const price = typeof item.price === "number" ? item.price : 0;

                  const extras = item.extras && item.extras.length
                    ? `\nExtras:\n${item.extras
                        .map(e => ` - ${e.name} (GHC${parseFloat(e.price || 0).toFixed(2)}) ${e.quantity || 1}x`)
                        .join("\n")}`
                    : "";

                  return `${qty}x ${name}${size} - GHC${(price * qty).toFixed(2)}${extras}`;
                })
                .join("\n");

              const msg = `
New Order Received!

Restaurant: ${order.restaurantName || "N/A"}
Items:
${cartSummary || "No items"}
Note: ${delivery.note || "None"}
Total: GHC${order.totalAmount?.toFixed(2) || "0.00"}


Location: ${delivery.hostel || "N/A"}, Room ${delivery.location || "-"}
Customer: ${order.userName || "Unknown"}
Contact: ${delivery.contactNumber || "-"}

Order ID: ${orderId}
              `.trim();

              const to = process.env.HUBTEL_ALERT_NUMBER;
              if (to) await sendHubtelSMS(to, msg);

              await db.collection("orders").doc(orderId).update({ smsSent: true });
              console.log(`✅ SMS marked sent for order ${orderId}`);
            }
          });
        },
        (err) => {
          console.error("❌ Firestore listener error:", err);
          console.log("🔁 Attempting to restart listener in 15 seconds...");
          setTimeout(startOrderListener, 15000); // auto-restart after 15 seconds
        }
      );
  } catch (error) {
    console.error("🔥 Critical Firestore listener failure:", error);
    console.log("🔁 Restarting listener in 30 seconds...");
    setTimeout(startOrderListener, 30000);
  }
}


// 🔁 Restart listener hourly
startOrderListener();
setInterval(() => {
  console.log('🔁 Restarting order listener...');
  startOrderListener();
}, 60 * 60 * 1000);

// 🔥 Health check
app.get('/', (req, res) => {
  res.send('🔥 Chawp SMS Server (Hubtel) running...');
});

// 🫀 Keep Railway alive
setInterval(() => {
  fetch(`https://chawp-sms.up.railway.app/`)
    .then(() => console.log('🔄 Keep-alive ping success'))
    .catch((err) => console.error('⚠️ Keep-alive ping failed:', err));
}, 5 * 60 * 1000);

// 🌐 Start Express server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ SMS Server listening on port ${PORT}`));
