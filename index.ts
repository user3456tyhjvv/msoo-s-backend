/*
 * =============================================================================
 *  Msoo's Beddings Serverless Backend for Vercel
 * =============================================================================
 *
 *  This file acts as a single serverless function that routes requests
 *  for the Pesapal payment integration. It replaces the Express server
 *  for compatibility with serverless environments like Vercel.
 *
 *  To deploy, you would configure Vercel to route API calls (e.g., /api/*)
 *  to this serverless function.
 *
 *  Environment Variables Required on Vercel:
 *  - PESAPAL_CONSUMER_KEY
 *  - PESAPAL_CONSUMER_SECRET
 *  - PESAPAL_API_URL
 *  - FIREBASE_SERVICE_ACCOUNT_JSON (The JSON content of your service account key)
 *  - APP_BASE_URL (your frontend URL)
 */

import axios from 'axios';
import admin from 'firebase-admin';
import { URL } from 'url';

// Minimal types for Vercel's request/response objects to avoid module resolution errors
interface VercelRequest {
  method?: string;
  url?: string;
  headers: { [key: string]: string | string[] | undefined };
  query: { [key: string]: string | string[] | undefined };
  body: any;
}

interface VercelResponse {
  setHeader(name: string, value: string | number | readonly string[]): VercelResponse;
  status(statusCode: number): VercelResponse;
  json(data: any): VercelResponse;
  send(body: any): VercelResponse;
  end(): VercelResponse;
}


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
    console.error("Firebase Admin initialization failed. Ensure your FIREBASE_SERVICE_ACCOUNT_JSON environment variable is set correctly in Vercel.");
  }
}
const db = admin.firestore();

// --- Pesapal Configuration ---
const PESAPAL_CONFIG = {
  CONSUMER_KEY: process.env.PESAPAL_CONSUMER_KEY,
  CONSUMER_SECRET: process.env.PESAPAL_CONSUMER_SECRET,
  API_URL: process.env.PESAPAL_API_URL || 'https://cybqa.pesapal.com/pesapalv3/api',
  IPN_CALLBACK_URL: `https://${process.env.VERCEL_URL}/api/pesapal/callback`, // Needs to be configured in Pesapal dashboard
  REDIRECT_URL: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/#/pesapal-callback`
};

// --- Pesapal API Helper Function ---
const getPesapalAuthToken = async (): Promise<string> => {
    try {
        const response = await axios.post(`${PESAPAL_CONFIG.API_URL}/Auth/RequestToken`, {
            consumer_key: PESAPAL_CONFIG.CONSUMER_KEY,
            consumer_secret: PESAPAL_CONFIG.CONSUMER_SECRET,
        });
        return response.data.token;
    } catch (error) {
        console.error("Error getting Pesapal token:", error);
        throw new Error("Could not authenticate with Pesapal.");
    }
};

// --- Route Handlers ---

const handleOrder = async (req: VercelRequest, res: VercelResponse) => {
    const { order, orderId } = req.body;
    if (!order || !orderId) {
        return res.status(400).json({ success: false, message: "Missing order data." });
    }

    try {
        const authToken = await getPesapalAuthToken();
        const pesapalOrderData = {
            id: orderId, currency: "KES", amount: order.total, description: `Payment for Order #${orderId.substring(0,8)}`,
            callback_url: PESAPAL_CONFIG.REDIRECT_URL,
            notification_id: PESAPAL_CONFIG.IPN_CALLBACK_URL,
            billing_address: {
                email_address: order.user.email, phone_number: order.user.phone, first_name: order.user.name.split(' ')[0],
                last_name: order.user.name.split(' ').slice(1).join(' ') || order.user.name.split(' ')[0],
            }
        };

        const response = await axios.post(`${PESAPAL_CONFIG.API_URL}/Transactions/SubmitOrderRequest`, pesapalOrderData, {
            headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
        
        if (response.data && response.data.redirect_url) {
            return res.json({ success: true, paymentUrl: response.data.redirect_url });
        } else {
            throw new Error(response.data.error?.message || "Failed to submit order to Pesapal.");
        }
    } catch (error: any) {
        console.error("Pesapal order submission failed:", error.response?.data || error.message);
        return res.status(500).json({ success: false, message: "Server error while creating payment request." });
    }
};

const handleCallback = async (req: VercelRequest, res: VercelResponse) => {
    const { OrderTrackingId, OrderMerchantReference } = req.query;
    if (!OrderTrackingId || !OrderMerchantReference) return res.status(400).send("Invalid IPN request.");
    
    try {
        const authToken = await getPesapalAuthToken();
        const statusUrl = `${PESAPAL_CONFIG.API_URL}/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`;
        const statusResponse = await axios.get(statusUrl, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const { status_code } = statusResponse.data;

        if (status_code === 1) { // COMPLETED
             const orderId = OrderMerchantReference as string;
             const orderRef = db.collection('orders').doc(orderId);
             await db.runTransaction(async t => {
                const orderDoc = await t.get(orderRef);
                if (!orderDoc.exists) throw new Error("Order not found!");
                const orderData = orderDoc.data()!;
                if(orderData.status === 'Processing') return; // Avoid double processing
                const userRef = db.collection('users').doc(orderData.user.id);
                const userDoc = await t.get(userRef);
                if (!userDoc.exists) throw new Error("User not found!");
                const userData = userDoc.data()!;
                const pointsEarned = Math.floor(orderData.subtotal / 100);
                const newPointsTotal = (userData.points || 0) - orderData.pointsRedeemed + pointsEarned;
                t.update(orderRef, { status: 'Processing', pointsEarned, paymentDetails: { trackingId: OrderTrackingId, method: statusResponse.data.payment_method, confirmedOn: new Date() }});
                t.update(userRef, { points: newPointsTotal });
             });
        } else {
             await db.collection('orders').doc(OrderMerchantReference as string).update({ status: 'Payment Failed' });
        }
        res.status(200).send("Callback received successfully.");
    } catch (error) {
        console.error("Error in IPN callback handler:", error);
        res.status(500).send("Error processing IPN.");
    }
};

const handleTransactionStatus = async (req: VercelRequest, res: VercelResponse) => {
    const { pesapalTrackingId } = req.query;
    if (!pesapalTrackingId) return res.status(400).json({ status: 'INVALID', description: 'Missing tracking ID.' });

    try {
        const authToken = await getPesapalAuthToken();
        const statusUrl = `${PESAPAL_CONFIG.API_URL}/Transactions/GetTransactionStatus?orderTrackingId=${pesapalTrackingId}`;
        const response = await axios.get(statusUrl, { headers: { 'Authorization': `Bearer ${authToken}` }});
        const { status_code, payment_method, description } = response.data;
        let status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'INVALID' = 'INVALID';
        if (status_code === 1) status = 'COMPLETED';
        if (status_code === 2 || status_code === 0) status = 'FAILED';
        if (status_code === 3) status = 'PENDING';
        res.json({ status, payment_method, description });
    } catch (error) {
        console.error("Error getting transaction status:", error);
        res.status(500).json({ status: 'FAILED', description: 'Server error while verifying status.' });
    }
};

// --- Main Serverless Function Handler ---
// --- Main Serverless Function Handler ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
    // --- CORS ---
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', process.env.APP_BASE_URL || 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // --- Routing ---
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (path === '/api' || path === '/api/') {
        return res.status(200).send("✅ Backend is working 🚀");
    }

    if (path.endsWith('/health') && req.method === 'GET') {
        return res.json({ status: 'ok', message: 'Backend is healthy' });
    }

    if (path.endsWith('/pesapal/order') && req.method === 'POST') {
        return handleOrder(req, res);
    }
    if (path.endsWith('/pesapal/callback') && req.method === 'GET') {
        return handleCallback(req, res);
    }
    if (path.endsWith('/pesapal/transaction-status') && req.method === 'GET') {
        return handleTransactionStatus(req, res);
    }

    return res.status(404).json({ message: 'Not Found' });
}
