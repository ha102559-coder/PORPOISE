const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// ═══════════════════════════════════════════════════════
//  綠界設定
// ═══════════════════════════════════════════════════════
const ECPAY = {
const ECPAY = {
  MerchantID: process.env.ECPAY_MERCHANT_ID,
  HashKey:    process.env.ECPAY_HASH_KEY,
  HashIV:     process.env.ECPAY_HASH_IV,
  PaymentURL: "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5",
  QueryURL:   "https://payment.ecpay.com.tw/Cashier/QueryTradeInfo/V5",
};

// ═══════════════════════════════════════════════════════
//  工具函式：計算 CheckMacValue
// ═══════════════════════════════════════════════════════
function genCheckMac(params) {
  // 1. 依 key 排序
  const sorted = Object.keys(params)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  // 2. 加上 HashKey / HashIV
  const raw = `HashKey=${ECPAY.HashKey}&${sorted}&HashIV=${ECPAY.HashIV}`;

  // 3. URL encode（綠界特規）
  const encoded = encodeURIComponent(raw)
    .replace(/%20/g, "+")
    .replace(/%21/g, "!")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%2a/g, "*")
    .toLowerCase();

  // 4. SHA256
  return crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase();
}

// ═══════════════════════════════════════════════════════
//  [POST] /createOrder  — 建立訂單 + 產生綠界表單
// ═══════════════════════════════════════════════════════
exports.createOrder = functions.https.onCall(async (data, context) => {
  const { items, buyer, paymentType } = data;
  // items: [{ productId, name, qty, price }]
  // buyer: { name, email, phone, address }
  // paymentType: "Credit" | "ATM" | "CVS"

  if (!items || !buyer || !paymentType) {
    throw new functions.https.HttpsError("invalid-argument", "缺少必要欄位");
  }

  // 計算金額
  const totalAmount = items.reduce((s, i) => s + i.price * i.qty, 0);
  if (totalAmount <= 0) throw new functions.https.HttpsError("invalid-argument", "金額異常");

  // 產生訂單編號（綠界限 20 碼英數）
  const merchantTradeNo = "PRP" + Date.now().toString().slice(-14) + Math.floor(Math.random() * 100);

  // 商品描述
  const itemName = items.map((i) => `${i.name} x${i.qty}`).join("#");

  // 寫入 Firestore
  const orderRef = db.collection("orders").doc(merchantTradeNo);
  await orderRef.set({
    merchantTradeNo,
    items,
    buyer,
    totalAmount,
    paymentType,
    status: "pending",       // pending | paid | failed | shipped | delivered
    logistics: [],           // 物流動態陣列
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    paidAt: null,
    ecpayTradeNo: null,
  });

  // 組裝綠界參數
  // ReturnURL / ClientBackURL 請換成你的實際網域
  const SITE_URL = "YOUR_SITE_URL"; // ← 部署後替換，例如 https://yoursite.com

  const params = {
    MerchantID: ECPAY.MerchantID,
    MerchantTradeNo: merchantTradeNo,
    MerchantTradeDate: new Date()
      .toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })
      .replace(/\//g, "/")
      .slice(0, 19),
    PaymentType: "aio",
    TotalAmount: String(totalAmount),
    TradeDesc: "PORPOISE 顯示器",
    ItemName: itemName,
    ReturnURL: `https://us-central1-monitor-c671b.cloudfunctions.net/ecpayReturn`,
    ClientBackURL: `${SITE_URL}/order.html?no=${merchantTradeNo}`,
    OrderResultURL: `${SITE_URL}/order.html?no=${merchantTradeNo}`,
    ChoosePayment: paymentType === "Credit" ? "Credit" : paymentType === "ATM" ? "ATM" : "CVS",
    EncryptType: "1",
    // ATM 設定
    ...(paymentType === "ATM" && { ExpireDate: "3" }),
    // 超商代碼
    ...(paymentType === "CVS" && { StoreExpireSeconds: "1200", Desc_1: "PORPOISE 顯示器" }),
  };

  params.CheckMacValue = genCheckMac(params);

  return { formUrl: ECPAY.PaymentURL, params, orderNo: merchantTradeNo };
});

// ═══════════════════════════════════════════════════════
//  [POST] /ecpayReturn  — 綠界付款通知（後端接收）
// ═══════════════════════════════════════════════════════
exports.ecpayReturn = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const body = req.body;
  const receivedMac = body.CheckMacValue;

  // 驗證 CheckMacValue
  const paramsForCheck = { ...body };
  delete paramsForCheck.CheckMacValue;
  const calcMac = genCheckMac(paramsForCheck);

  if (receivedMac.toUpperCase() !== calcMac) {
    console.error("CheckMacValue 驗證失敗");
    return res.send("0|Error");
  }

  const merchantTradeNo = body.MerchantTradeNo;
  const rtnCode = body.RtnCode; // "1" = 成功
  const ecpayTradeNo = body.TradeNo;

  const orderRef = db.collection("orders").doc(merchantTradeNo);
  const snap = await orderRef.get();
  if (!snap.exists) return res.send("0|OrderNotFound");

  if (rtnCode === "1") {
    await orderRef.update({
      status: "paid",
      ecpayTradeNo,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      "logistics": admin.firestore.FieldValue.arrayUnion({
        time: new Date().toISOString(),
        status: "付款成功",
        note: `綠界交易編號：${ecpayTradeNo}`,
      }),
    });
  } else {
    await orderRef.update({ status: "failed" });
  }

  // 綠界要求回傳 "1|OK"
  res.send("1|OK");
});

// ═══════════════════════════════════════════════════════
//  [CALL] /queryOrder — 查詢訂單狀態
// ═══════════════════════════════════════════════════════
exports.queryOrder = functions.https.onCall(async (data) => {
  const { orderNo } = data;
  if (!orderNo) throw new functions.https.HttpsError("invalid-argument", "缺少訂單編號");

  const snap = await db.collection("orders").doc(orderNo).get();
  if (!snap.exists) throw new functions.https.HttpsError("not-found", "訂單不存在");

  const d = snap.data();
  return {
    orderNo: d.merchantTradeNo,
    status: d.status,
    totalAmount: d.totalAmount,
    items: d.items,
    buyer: d.buyer,
    paymentType: d.paymentType,
    logistics: d.logistics || [],
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    paidAt: d.paidAt?.toDate?.()?.toISOString() || null,
  };
});

// ═══════════════════════════════════════════════════════
//  [CALL] /updateLogistics — 後台更新物流（需管理員）
// ═══════════════════════════════════════════════════════
exports.updateLogistics = functions.https.onCall(async (data, context) => {
  // 驗證 Google 登入且為管理員
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "請先登入");
  if (context.auth.token.email !== "enzdwllg@gmail.com") {
    throw new functions.https.HttpsError("permission-denied", "無管理員權限");
  }

  const { orderNo, statusText, note, newOrderStatus } = data;
  if (!orderNo || !statusText) throw new functions.https.HttpsError("invalid-argument", "缺少欄位");

  const orderRef = db.collection("orders").doc(orderNo);
  const snap = await orderRef.get();
  if (!snap.exists) throw new functions.https.HttpsError("not-found", "訂單不存在");

  const update = {
    logistics: admin.firestore.FieldValue.arrayUnion({
      time: new Date().toISOString(),
      status: statusText,
      note: note || "",
    }),
  };
  if (newOrderStatus) update.status = newOrderStatus;

  await orderRef.update(update);
  return { success: true };
});
