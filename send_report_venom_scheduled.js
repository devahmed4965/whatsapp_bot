// send_report_venom_scheduled.js
// هذا السكربت يستخدم مكتبة venom-bot لإرسال رسائل واتساب بشكل مجدول.
// يقوم بالاتصال بقاعدة بيانات PostgreSQL، جلب بيانات التقرير، تنسيق الرسالة،
// ثم يرسل هذا المحتوى إلى معرف دردشة واتساب محدد كل 24 ساعة.

// استيراد المكتبات المطلوبة
const venom = require('venom-bot');
const fs = require('fs'); 
const path = require('path');
const { Pool } = require('pg'); 
const cron = require('node-cron'); // مكتبة لجدولة المهام

// --- إعدادات ---
const DATABASE_URL = "postgresql://shipments_owner:npg_LBrZfvsy1m6S@ep-mute-sun-a5v8rm1v-pooler.us-east-2.aws.neon.tech/shipments?sslmode=require"; 
const TARGET_CHAT_ID = '120363399385564131@g.us'; // معرف المجموعة
const SESSION_NAME = 'daily-report-scheduled-session'; // اسم جلسة مميز
const MAX_IDS_TO_DISPLAY_IN_REPORT = 50; 

// توقيت إرسال التقرير
// الصيغة: 'دقيقة ساعة يوم_في_الشهر شهر يوم_في_الأسبوع'
// لمزيد من المعلومات حول صيغة cron: https://crontab.guru/
// !!! تم تعديل التوقيت ليكون الساعة 10:00 مساءً !!!
const CRON_SCHEDULE = '0 22 * * *'; // كل يوم الساعة 10:00 مساءً (22:00)

const pool = new Pool({
  connectionString: DATABASE_URL,
  // ssl: { rejectUnauthorized: false } 
});

pool.on('error', (err, client) => {
  console.error('خطأ غير متوقع في عميل قاعدة البيانات الخامل', err);
  // لا تقم بـ process.exit(-1) هنا مباشرة، دع السكربت يحاول الاستمرار أو إعادة الاتصال إذا أمكن
});

async function getDailyReportDataFromDB() {
  console.log(`[${new Date().toLocaleString()}] جاري جلب بيانات التقرير من قاعدة البيانات...`);
  let dbClient;
  try {
    dbClient = await pool.connect(); 
    const today = new Date().toISOString().slice(0, 10); 
    const time24HoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const uncheckedQuery = `
      SELECT shipment_id 
      FROM shipments
      WHERE checked = FALSE AND created_at >= $1
      ORDER BY created_at DESC;
    `;
    const uncheckedResult = await dbClient.query(uncheckedQuery, [time24HoursAgo]);
    const uncheckedShipmentIdsLast24h = uncheckedResult.rows.map(row => row.shipment_id);

    const remainingQuery = `SELECT COUNT(id) AS count FROM shipments WHERE checked = FALSE;`;
    const remainingResult = await dbClient.query(remainingQuery);
    const remainingShipmentsCountTotal = parseInt(remainingResult.rows[0].count, 10) || 0;

    const checkedTodayQuery = `
      SELECT COUNT(id) AS count 
      FROM shipments 
      WHERE checked = TRUE AND DATE(inspected_date) = CURRENT_DATE;
    `;
    const checkedTodayResult = await dbClient.query(checkedTodayQuery);
    const checkedTodayCount = parseInt(checkedTodayResult.rows[0].count, 10) || 0;

    console.log(`[${new Date().toLocaleString()}] البيانات المستخلصة: الإجمالي المتبقي=${remainingShipmentsCountTotal}, غير مفحوص آخر 24س=${uncheckedShipmentIdsLast24h.length}, مفحوص اليوم=${checkedTodayCount}`);
    return {
      remainingShipmentsCountTotal,
      checkedTodayCount,
      uncheckedShipmentIdsLast24h,
    };
  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] خطأ أثناء جلب البيانات من قاعدة البيانات:`, error);
    return null; 
  } finally {
    if (dbClient) dbClient.release(); 
  }
}

function formatReportMessage(reportData) {
  const {
    remainingShipmentsCountTotal,
    checkedTodayCount,
    uncheckedShipmentIdsLast24h,
  } = reportData;

  const todayStr = new Date().toLocaleDateString('ar-EG-u-nu-latn', { year: 'numeric', month: '2-digit', day: '2-digit' }); 
  const generationTimeStr = new Date().toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  let messageLines = [];
  messageLines.push(`📊 تقرير الشحنات اليومي (${todayStr}) 📊`);
  messageLines.push("");
  messageLines.push(`📦 إجمالي الشحنات المتبقية (غير مفحوصة): ${remainingShipmentsCountTotal}`);
  messageLines.push(`✅ إجمالي الشحنات التي تم فحصها اليوم: ${checkedTodayCount}`);
  messageLines.push("");

  const countLast24h = uncheckedShipmentIdsLast24h.length;
  if (countLast24h > 0) {
    messageLines.push(`📋 شحنات غير مفحوصة أضيفت آخر 24 ساعة (${countLast24h} شحنة):`);
    const idsToDisplay = uncheckedShipmentIdsLast24h.slice(0, MAX_IDS_TO_DISPLAY_IN_REPORT);
    idsToDisplay.forEach(s_id => messageLines.push(`- ${s_id}`));
    if (countLast24h > MAX_IDS_TO_DISPLAY_IN_REPORT) {
      messageLines.push(`... و ${countLast24h - MAX_IDS_TO_DISPLAY_IN_REPORT} شحنة أخرى.`);
    }
  } else {
    messageLines.push("👍 لا توجد شحنات غير مفحوصة أضيفت خلال الـ 24 ساعة الماضية.");
  }
  messageLines.push("");
  messageLines.push("---");
  messageLines.push(`🕒 وقت إنشاء التقرير: ${generationTimeStr}`);

  return messageLines.join('\n');
}

async function sendWhatsAppMessage(client, chatId, message) {
    try {
        console.log(`[${new Date().toLocaleString()}] جاري إرسال الرسالة إلى: ${chatId}`);
        await client.sendText(chatId, message.trim());
        console.log(`[${new Date().toLocaleString()}] تم إرسال الرسالة بنجاح إلى: ${chatId}`);
        return true;
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] حدث خطأ عند إرسال الرسالة إلى ${chatId}:`, error);
        return false;
    }
}

async function main() {
  let venomClient;
  try {
    console.log(`[${new Date().toLocaleString()}] جاري إنشاء عميل Venom (جلسة: ${SESSION_NAME})...`);
    venomClient = await venom.create(
      SESSION_NAME,
      (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`[${new Date().toLocaleString()}] حالة QR: محاولة ${attempts}`);
        console.log(asciiQR); 
      },
      (statusSession, session) => {
        console.log(`[${new Date().toLocaleString()}] حالة الجلسة:`, statusSession);
        if (statusSession === 'qrReadSuccess') {
          console.log(`[${new Date().toLocaleString()}] تم مسح QR بنجاح!`);
        }
        if (statusSession === 'isLogged' || statusSession === 'successChat') {
          console.log(`[${new Date().toLocaleString()}] تم الاتصال بواتساب بنجاح!`);
        }
      },
      {
        headless: 'new',
        devtools: false,
        useChrome: true,
        debug: false,
        logQR: true,
        browserArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        autoClose: 0, 
        disableSpins: true,
        puppeteerOptions: {},
        sessionDataPath: './.venom_sessions/' 
      }
    );
    console.log(`[${new Date().toLocaleString()}] تم إنشاء عميل Venom بنجاح.`);

    console.log(`[${new Date().toLocaleString()}] جدولة إرسال التقرير ليتم كل يوم في التوقيت المحدد بالـ cron (${CRON_SCHEDULE})`);
    cron.schedule(CRON_SCHEDULE, async () => {
      console.log(`\n[${new Date().toLocaleString()}] حان وقت إرسال التقرير اليومي...`);
      const reportData = await getDailyReportDataFromDB();
      if (reportData) {
        const messageContent = formatReportMessage(reportData);
        console.log('-------------------- محتوى الرسالة المجهز --------------------');
        console.log(messageContent);
        console.log('-------------------------------------------------------------');
        await sendWhatsAppMessage(venomClient, TARGET_CHAT_ID, messageContent);
      } else {
        console.log(`[${new Date().toLocaleString()}] لم يتم جلب بيانات التقرير، تخطي الإرسال هذه المرة.`);
      }
    }, {
      scheduled: true,
      timezone: "Africa/Cairo" // !!! قم بتعيين المنطقة الزمنية الصحيحة لخادمك !!!
    });

    console.log(`[${new Date().toLocaleString()}] السكربت يعمل الآن وسيرسل التقرير التالي في الموعد المحدد.`);
    console.log(`[${new Date().toLocaleString()}] اضغط Ctrl+C لإيقاف السكربت.`);

  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] حدث خطأ فادح في العملية الرئيسية:`, error);
    if (venomClient) {
      try {
        await venomClient.close();
      } catch (closeError) {
        console.error(`[${new Date().toLocaleString()}] خطأ أثناء محاولة إغلاق عميل Venom بعد خطأ فادح:`, closeError);
      }
    }
    process.exit(1); 
  }
}

// --- بدء تشغيل السكربت ---
if (!TARGET_CHAT_ID || !TARGET_CHAT_ID.endsWith('@g.us')) {
    console.error("خطأ فادح: لم يتم تعيين 'TARGET_CHAT_ID' بشكل صحيح كمعرف مجموعة في السكربت.");
    console.error("القيمة الحالية: ", TARGET_CHAT_ID);
    console.error("يرجى التأكد من أن 'TARGET_CHAT_ID' هو معرف مجموعة بالصيغة 'معرف_المجموعة_الفعلي@g.us'.");
    process.exit(1); 
}

main();
