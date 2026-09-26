# MJ Hesari Google Flow

افزونهٔ کروم شخصی [جواد حصاری (MJ Hesari)](https://www.mj-hesari.ir/) برای رفع محدودیت دسترسی به [Google Flow](https://flow.google.com/).

> این ابزار برای دور زدن صفحهٔ `/unavailable` و محدودیت جغرافیایی سمت کلاینت طراحی شده است. برای کار درست، به VPN با IP ثابت کشورهای پشتیبانی‌شده نیاز دارید.

## امکانات

- فعال/غیرفعال کردن ابزار از پنل افزونه
- پچ پاسخ‌های `batchexecute` (XHR و `fetch`)
- ریدایرکت خودکار از `/unavailable` و `/unsupported-country`
- برند و لینک‌های شخصی MJ Hesari

## نصب (Developer Mode)

1. این ریپو را کلون کنید:

```bash
git clone https://github.com/mjhesari/mj-hesari-google-flow.git
cd mj-hesari-google-flow
```

2. کروم را باز کنید و بروید به:

```text
chrome://extensions
```

3. گوشهٔ بالا-راست، **Developer mode** را روشن کنید.
4. روی **Load unpacked** بزنید و پوشهٔ همین پروژه را انتخاب کنید.
5. آیکون **MJ Hesari Flow** را در نوار ابزار پین کنید.

## طرز استفاده

1. روی آیکون افزونه کلیک کنید.
2. سوییچ **فعالسازی ابزار** را روشن کنید.
3. روی **بازکردن گوگل فلو** بزنید (یا خودتان بروید به `https://flow.google.com/`).
4. اگر صفحهٔ محدودیت بود، روی **بارگذاری دوباره گوگل فلو** بزنید تا از `/unavailable` خارج شوید.
5. یک بار صفحه را رفرش کنید تا پچ اعمال شود.

### نکات مهم

- VPN را روی کشور غیرتحریمی با **IP ثابت** بگذارید.
- با اکانت Googleای وارد شوید که به Flow دسترسی دارد (مثلاً اشتراک AI Pro / Ultra در صورت نیاز).
- بعد از هر آپدیت افزونه، در `chrome://extensions` دکمهٔ **Reload** را بزنید.

## ساختار پروژه

```text
mj-hesari-google-flow/
├── manifest.json   # تنظیمات افزونه (MV3)
├── app.js          # service worker — ثبت اسکریپت و دریافت spec
├── engine.js       # موتور پچ داخل صفحهٔ Flow (MAIN world)
├── link.js         # پل بین افزونه و صفحه برای ارسال spec
├── stat.js         # گزارش وضعیت به پنل
├── panel.html      # UI پنل
├── panel.css       # استایل برند MJ Hesari
├── panel.js        # منطق پنل
└── assets/         # آیکون‌ها و فونت
```

## توسعه

- حداقل نسخهٔ کروم: **111**
- Manifest Version: **3**
- بعد از تغییر فایل‌ها، افزونه را در `chrome://extensions` ریلود کنید.

## لینک‌ها

- سایت: [mj-hesari.ir](https://www.mj-hesari.ir/)
- تماس: [mj-hesari.ir/#contact](https://www.mj-hesari.ir/#contact)
- تلگرام: [@Mjhe3ari](https://t.me/Mjhe3ari)
- اینستاگرام: [hesari.dev](https://instagram.com/hesari.dev)
- گیت‌هاب: [mjhesari](https://github.com/mjhesari)

## سلب مسئولیت

این پروژه آموزشی/شخصی است و مسئولیتی در قبال تغییر سیاست‌های Google یا قطع دسترسی ندارد. استفاده مطابق قوانین محلی و شرایط سرویس Google بر عهدهٔ کاربر است.

---

Made by [MJ Hesari](https://www.mj-hesari.ir/) · Full Stack Developer
