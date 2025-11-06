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
    const response = await fetch('https://smsc.hubtel.com/v1/messages/send', {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(
            `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
          ).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        From: 'Chawp',
        To: to,
        Content: message,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('❌ Hubtel SMS error:', data);
    } else {
      console.log('✅ SMS sent to:', to, data);
    }
    return data;
  } catch (err) {
    console.error('❌ Failed to send Hubtel SMS:', err);
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
                    ? ` | Extras: ${item.extras.map(e => `${e.quantity}x ${e.name}`).join(", ")}`
                    : "";
                  return `${qty}x ${name}${size} - GH₵${(price * qty).toFixed(2)}${extras}`;
                })
                .join("\n");

              const msg = `
🍔 New Order Received!

Customer: ${order.userName || "Unknown"}
Restaurant: ${order.restaurantName || "N/A"}
Items:
${cartSummary || "No items"}

Total: GH₵${order.totalAmount?.toFixed(2) || "0.00"}
Location: ${delivery.hostel || "N/A"}, Room ${delivery.location || "-"}
Contact: ${delivery.contactNumber || "-"}
Note: ${delivery.note || "None"}

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
