import 'dotenv/config';
import express from 'express';
import admin from 'firebase-admin';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// 🔐 Initialize Firebase Admin from Base64
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 📩 Hubtel SMS sender
async function sendHubtelSMS(to, message) {
  try {
    const auth = Buffer.from(
      `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch('https://smsc.hubtel.com/v1/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        From: 'Hubtel',
        To: to,
        Content: message,
      }),
    });

    const text = await response.text();
    console.log('📨 Hubtel response:', response.status, text);
  } catch (err) {
    console.error('🔥 Hubtel fetch error:', err);
  }
}

// 🔔 Listen for new orders
let unsubscribeOrders = null;

function startOrderListener() {
  if (unsubscribeOrders) unsubscribeOrders();
  console.log('📡 Firestore order listener started...');

  unsubscribeOrders = db
    .collection('orders')
    .where('status', '==', 'pending')
    .where('smsSent', '==', false)
    .onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          if (change.type === 'added') {
            const order = change.doc.data();
            const orderId = change.doc.id;
            console.log(`🆕 New pending order: ${orderId}`);

            const delivery = order.deliveryDetails || {};
            const cart = Array.isArray(order.cart)
              ? order.cart
              : Array.isArray(order.cartItems)
              ? order.cartItems
              : [];

            const cartSummary = cart
              .map((item) => {
                const name = item.name || 'Unnamed Item';
                const qty = item.quantity ?? 1;
                const size = item.size ? ` (${item.size})` : '';
                const price = typeof item.price === 'number' ? item.price : 0;

                const extras =
                  item.extras && item.extras.length
                    ? `\nExtras:\n${item.extras
                        .map(
                          (e) =>
                            ` - ${e.name} (GHC${parseFloat(
                              e.price || 0
                            ).toFixed(2)}) ${e.quantity || 1}x`
                        )
                        .join('\n')}`
                    : '';

                return `${qty}x ${name}${size} - GHC${(
                  price * qty
                ).toFixed(2)}${extras}`;
              })
              .join('\n');

            const msg = `
New Order Received!

Restaurant: ${order.restaurantName || 'N/A'}
Items:
${cartSummary || 'No items'}
Note: ${delivery.note || 'None'}
Total: GHC${order.totalAmount?.toFixed(2) || '0.00'}

Location: ${delivery.hostel || 'N/A'}, Room ${delivery.location || '-'}
Customer: ${order.userName || 'Unknown'}
Contact: ${delivery.contactNumber || '-'}

Order ID: ${orderId}
            `.trim();

            const to = process.env.HUBTEL_ALERT_NUMBER;
            if (to) await sendHubtelSMS(to, msg);

            await db.collection('orders').doc(orderId).update({ smsSent: true });
            console.log(`✅ SMS sent and marked for order ${orderId}`);
          }
        });
      },
      (err) => {
        console.error('❌ Firestore listener error:', err);
        setTimeout(startOrderListener, 15000);
      }
    );
}

// 🔁 Restart listener hourly
startOrderListener();
setInterval(startOrderListener, 60 * 60 * 1000);

// 🔥 Health check
app.get('/', (req, res) => {
  res.send('🔥 Chawp SMS Server (Hubtel) running...');
});

// 🫀 Keep Railway alive
setInterval(() => {
  fetch(`https://chawp-sms.up.railway.app/`).catch(() => {});
}, 5 * 60 * 1000);

// 🌐 Start Express server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
