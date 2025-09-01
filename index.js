/*
 * =============================================================================
 *  Msoo's Beddings Express Backend for Render
 * =============================================================================
 *
 *  This file implements an Express server that handles routes
 *  for the Pesapal payment integration. It replaces the serverless function
 *  for compatibility with traditional hosting environments like Render.
 *
 *  Environment Variables Required on Render:
 *  - PESAPAL_CONSUMER_KEY
 *  - PESAPAL_CONSUMER_SECRET
 *  - PESAPAL_API_URL
 *  - FIREBASE_SERVICE_ACCOUNT_JSON (The JSON content of your service account key)
 *  - APP_BASE_URL (your frontend URL)
 *  - PORT (optional, defaults to 3000)
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const { URL } = require('url');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware Configuration ---
app.use(cors({
  origin: process.env.APP_BASE_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Firebase Admin Initialization ---
if (!admin.apps.length) {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error("Firebase Admin initialization failed. Ensure your FIREBASE_SERVICE_ACCOUNT_JSON environment variable is set correctly.");
  }
}
const db = admin.firestore();

// --- Pesapal Configuration ---
const PESAPAL_CONFIG = {
  CONSUMER_KEY: process.env.PESAPAL_CONSUMER_KEY,
  CONSUMER_SECRET: process.env.PESAPAL_CONSUMER_SECRET,
  API_URL: process.env.PESAPAL_API_URL || 'https://cybqa.pesapal.com/pesapalv3/api',
  IPN_CALLBACK_URL: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/api/pesapal/callback`,
  REDIRECT_URL: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/#/pesapal-callback`
};

// --- Pesapal API Helper Function ---
const getPesapalAuthToken = async () => {
  try {
    const response = await axios.post(`${PESAPAL_CONFIG.API_URL}/Auth/RequestToken`, {
      consumer_key: PESAPAL_CONFIG.CONSUMER_KEY,
      consumer_secret: PESAPAL_CONFIG.CONSUMER_SECRET,
    }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
    return response.data.token;
  } catch (error) {
    console.error("Error getting Pesapal token:", error.response?.data || error.message);
    throw new Error("Could not authenticate with Pesapal.");
  }
};

// --- Route Handlers ---

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is healthy' });
});

// Root endpoint
app.get('/api', (req, res) => {
  res.send("✅ Backend is working 🚀");
});

// Handle order submission
app.post('/api/pesapal/order', async (req, res) => {
  const { order, orderId } = req.body;
  if (!order || !orderId) {
    return res.status(400).json({ success: false, message: "Missing order data." });
  }

  try {
    const authToken = await getPesapalAuthToken();
    const pesapalOrderData = {
      id: orderId,
      currency: "KES",
      amount: order.total,
      description: `Payment for Order #${orderId.substring(0, 8)}`,
      callback_url: PESAPAL_CONFIG.REDIRECT_URL,
      notification_id: PESAPAL_CONFIG.IPN_CALLBACK_URL,
      billing_address: {
        email_address: order.user.email,
        phone_number: order.user.phone,
        first_name: order.user.name.split(' ')[0],
        last_name: order.user.name.split(' ').slice(1).join(' ') || order.user.name.split(' ')[0],
      }
    };

    const response = await axios.post(
      `${PESAPAL_CONFIG.API_URL}/Transactions/SubmitOrderRequest`,
      pesapalOrderData,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    if (response.data && response.data.redirect_url) {
      return res.json({ success: true, paymentUrl: response.data.redirect_url });
    } else {
      throw new Error(response.data.error?.message || "Failed to submit order to Pesapal.");
    }
  } catch (error) {
    console.error("Pesapal order submission failed:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Server error while creating payment request."
    });
  }
});

// Handle Pesapal callback
app.get('/api/pesapal/callback', async (req, res) => {
  const { OrderTrackingId, OrderMerchantReference } = req.query;
  if (!OrderTrackingId || !OrderMerchantReference) {
    return res.status(400).send("Invalid IPN request.");
  }

  try {
    const authToken = await getPesapalAuthToken();
    const statusUrl = `${PESAPAL_CONFIG.API_URL}/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`;
    const statusResponse = await axios.get(statusUrl, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const { status_code } = statusResponse.data;

    if (status_code === 1) { // COMPLETED
      const orderId = OrderMerchantReference;
      const orderRef = db.collection('orders').doc(orderId);
      
      await db.runTransaction(async t => {
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) throw new Error("Order not found!");
        
        const orderData = orderDoc.data();
        if (orderData.status === 'Processing') return; // Avoid double processing
        
        const userRef = db.collection('users').doc(orderData.user.id);
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw new Error("User not found!");
        
        const userData = userDoc.data();
        const pointsEarned = Math.floor(orderData.subtotal / 100);
        const newPointsTotal = (userData.points || 0) - orderData.pointsRedeemed + pointsEarned;
        
        t.update(orderRef, {
          status: 'Processing',
          pointsEarned,
          paymentDetails: {
            trackingId: OrderTrackingId,
            method: statusResponse.data.payment_method,
            confirmedOn: new Date()
          }
        });
        
        t.update(userRef, { points: newPointsTotal });
      });
    } else {
      await db.collection('orders').doc(OrderMerchantReference).update({
        status: 'Payment Failed'
      });
    }
    
    res.status(200).send("Callback received successfully.");
  } catch (error) {
    console.error("Error in IPN callback handler:", error);
    res.status(500).send("Error processing IPN.");
  }
});

// Handle transaction status check
app.get('/api/pesapal/transaction-status', async (req, res) => {
  const { pesapalTrackingId } = req.query;
  if (!pesapalTrackingId) {
    return res.status(400).json({ status: 'INVALID', description: 'Missing tracking ID.' });
  }

  try {
    const authToken = await getPesapalAuthToken();
    const statusUrl = `${PESAPAL_CONFIG.API_URL}/Transactions/GetTransactionStatus?orderTrackingId=${pesapalTrackingId}`;
    const response = await axios.get(statusUrl, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    const { status_code, payment_method, description } = response.data;
    let status = 'INVALID';
    
    if (status_code === 1) status = 'COMPLETED';
    else if (status_code === 2 || status_code === 0) status = 'FAILED';
    else if (status_code === 3) status = 'PENDING';
    
    res.json({ status, payment_method, description });
  } catch (error) {
    console.error("Error getting transaction status:", error.response?.data || error.message);
    res.status(500).json({
      status: 'FAILED',
      description: 'Server error while verifying status.'
    });
  }
});

// Handle 404 for undefined API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ message: 'API endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Msoo's Beddings server listening on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/api/health`);
});

module.exports = app;