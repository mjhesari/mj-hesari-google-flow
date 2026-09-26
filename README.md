# MJ Hesari Google Flow

افزونهٔ کروم شخصی [جواد حصاری (MJ Hesari)](https://www.mj-hesari.ir/) برای رفع محدودیت دسترسی به [Google Flow](https://flow.google.com/).

> این ابزار برای دور زدن صفحهٔ `/unavailable` و محدودیت جغرافیایی سمت کلاینت طراحی شده است. برای کار درست، به VPN با IP ثابت کشورهای پشتیبانی‌شده نیاز دارید.

---

## نصب سریع

1. کلون کنید:

```bash
git clone git@github.com:mjhesari/mj-hesari-google-flow.git
cd mj-hesari-google-flow
```

2. در کروم باز کنید: `chrome://extensions`
3. **Developer mode** را روشن کنید
4. **Load unpacked** → پوشهٔ `mj-hesari-google-flow` را انتخاب کنید
5. آیکون **MJ Hesari Flow** را پین کنید

---

## طرز استفاده

| مرحله | کار |
|------|-----|
| ۱ | VPN را روی کشور غیرتحریمی با **IP ثابت** بگذارید |
| ۲ | روی آیکون افزونه کلیک کنید |
| ۳ | سوییچ **فعالسازی ابزار** را روشن کنید |
| ۴ | روی **بازکردن گوگل فلو** بزنید |
| ۵ | اگر صفحهٔ محدودیت بود، **بارگذاری دوباره گوگل فلو** را بزنید |
| ۶ | یک‌بار صفحه را رفرش کنید تا پچ اعمال شود |

### وضعیت‌های پنل

- **ابزار روشن است** → افزونه فعال شده؛ تب را رفرش کنید
- **ابزار روی این تب فعال است** → محدودیت دور زده شد
- **نیاز به آپدیت** → schema گوگل عوض شده
- **خطا در ارتباط** → اینترنت / دسترسی به سرور spec را چک کنید

### نکات مهم

- با اکانتی وارد شوید که به Flow دسترسی دارد (مثلاً Google AI Pro / Ultra در صورت نیاز)
- بعد از هر آپدیت کد، در `chrome://extensions` روی **Reload** بزنید
- اگر روی `/unavailable` ماندید، دکمهٔ بارگذاری دوباره مسیر را به ریشه برمی‌گرداند

---

## امکانات

- فعال/غیرفعال کردن ابزار از پنل
- پچ پاسخ‌های `batchexecute` روی **XHR** و **fetch**
- ریدایرکت خودکار از `/unavailable` و `/unsupported-country`
- برند و لینک‌های شخصی [MJ Hesari](https://www.mj-hesari.ir/#contact)

---

## ساختار پروژه

```text
mj-hesari-google-flow/
├── manifest.json   # تنظیمات افزونه (Manifest V3)
├── app.js          # service worker — ثبت اسکریپت و دریافت spec
├── engine.js       # موتور پچ داخل صفحهٔ Flow (MAIN world)
├── link.js         # پل بین افزونه و صفحه برای ارسال spec
├── stat.js         # گزارش وضعیت به پنل
├── panel.html      # UI پنل
├── panel.css       # استایل برند MJ Hesari
├── panel.js        # منطق پنل
├── assets/         # آیکون‌ها، برندمارک و فونت
└── README.md       # همین راهنما
```

---

## توسعه

- حداقل کروم: **111**
- Manifest: **v3**
- بعد از تغییر فایل‌ها، افزونه را در `chrome://extensions` ریلود کنید

```bash
# تست منطق پچ (Node)
node -e "require('./engine.js')"
```

---

## لینک‌ها

| | |
|--|--|
| سایت | [mj-hesari.ir](https://www.mj-hesari.ir/) |
| تماس | [mj-hesari.ir/#contact](https://www.mj-hesari.ir/#contact) |
| تلگرام | [@Mjhe3ari](https://t.me/Mjhe3ari) |
| اینستاگرام | [hesari.dev](https://instagram.com/hesari.dev) |
| گیت‌هاب | [mjhesari](https://github.com/mjhesari) |
| ایمیل | [hesarimj@gmail.com](mailto:hesarimj@gmail.com) |

---

## سلب مسئولیت

این پروژه آموزشی/شخصی است و مسئولیتی در قبال تغییر سیاست‌های Google یا قطع دسترسی ندارد. استفاده مطابق قوانین محلی و شرایط سرویس Google بر عهدهٔ کاربر است.

---

Made by [MJ Hesari](https://www.mj-hesari.ir/) · Full Stack Developer
