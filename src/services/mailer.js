import nodemailer from "nodemailer";

let transporterPromise = null;

export async function sendOtpEmail({ to, code, expiresInSeconds, purpose = "login" }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "BlockShift Arena <no-reply@blockshiftarena.local>";
  const minutes = Math.max(1, Math.ceil(expiresInSeconds / 60));
  const message = {
    from,
    to,
    subject: otpSubject(purpose),
    text: `Your BlockShift Arena ${otpPurposeLabel(purpose)} code is ${code}. It expires in ${minutes} minutes. If you did not request this, ignore this email.`,
    html: otpEmailHtml(code, minutes, purpose)
  };

  if (process.env.BREVO_API_KEY) {
    await sendBrevoApiEmail(message);
    return { mode: "brevo-api" };
  }

  const transporter = await smtpTransporter();
  if (!transporter) {
    if (process.env.NODE_ENV === "production" && process.env.EXPOSE_DEV_OTP === "false") {
      const error = new Error("email_delivery_unavailable");
      error.statusCode = 503;
      throw error;
    }
    console.info(`[auth:otp] ${to} -> ${code}`);
    return { mode: "dev-log" };
  }

  await transporter.sendMail({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html
  });
  return { mode: "smtp" };
}

async function sendBrevoApiEmail(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.BREVO_API_TIMEOUT_MS || 15000));
  try {
    const sender = parseSender(message.from);
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender,
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(`brevo_api_${response.status}`);
      error.statusCode = response.status >= 500 ? 502 : 400;
      throw error;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("brevo_api_timeout");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function smtpTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporterPromise) {
    transporterPromise = Promise.resolve(nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
      auth: process.env.SMTP_USER || process.env.SMTP_PASS
        ? {
            user: process.env.SMTP_USER || "",
            pass: process.env.SMTP_PASS || ""
          }
        : undefined,
      connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 15000),
      greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 15000),
      socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000)
    }));
  }
  return transporterPromise;
}

function otpSubject(purpose) {
  if (purpose === "signup") return "Verify your BlockShift Arena account";
  if (purpose === "password_reset") return "Reset your BlockShift Arena password";
  return "Your BlockShift Arena login code";
}

function otpPurposeLabel(purpose) {
  if (purpose === "signup") return "signup";
  if (purpose === "password_reset") return "password reset";
  return "login";
}

function emailAssetUrls() {
  const base = publicBaseUrl();
  return {
    avatarUrl: `${base}/email-assets/otp-avatar.png`,
    logoUrl: `${base}/email-assets/otp-logo.png`,
    backgroundUrl: `${base}/email-assets/otp-background.jpg`
  };
}

function publicBaseUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8080").trim();
  return (base || "http://localhost:8080").replace(/\/+$/, "");
}

function parseSender(value) {
  const from = String(value || "").trim();
  const bracketMatch = from.match(/^(?:"?([^"<]*)"?\s*)?<([^<>@\s]+@[^<>\s]+)>$/);
  if (bracketMatch) {
    return {
      name: bracketMatch[1].trim() || "BlockShift Arena",
      email: bracketMatch[2].trim()
    };
  }
  if (from.includes("@")) {
    return {
      name: "BlockShift Arena",
      email: from.replace(/^"|"$/g, "")
    };
  }
  return {
    name: "BlockShift Arena",
    email: "no-reply@blockshiftarena.local"
  };
}

function otpEmailHtml(code, minutes, purpose) {
  const { avatarUrl, logoUrl, backgroundUrl } = emailAssetUrls();
  const heading = `${otpPurposeLabel(purpose).replace(/^./, (c) => c.toUpperCase())} code`;
  return `
    <div style="margin:0;padding:0;background:#010615;color:#f8fdff;font-family:Inter,Arial,sans-serif">
      <div style="padding:28px 14px;background:#010615 url('${backgroundUrl}') center top / cover no-repeat">
        <div style="max-width:560px;margin:0 auto;border:1px solid #38bdf8;border-radius:24px;overflow:hidden;background:rgba(1,6,21,.94);box-shadow:0 28px 80px rgba(0,0,0,.58), 0 0 0 1px rgba(125,211,252,.16)">
          <div style="padding:28px 28px 24px;background:linear-gradient(180deg, rgba(1,6,21,.18), rgba(1,6,21,.9)), url('${backgroundUrl}') center center / cover no-repeat;border-bottom:1px solid rgba(125,211,252,.32)">
            <div style="margin:0 auto 18px;max-width:360px;padding:10px 14px;border-radius:18px;background:rgba(1,11,31,.82);border:1px solid rgba(125,211,252,.3);display:flex;align-items:center;gap:12px">
              <img src="${avatarUrl}" alt="BlockShift Arena profile" width="54" height="54" style="display:block;border-radius:16px;border:1px solid rgba(255,215,102,.72);box-shadow:0 0 22px rgba(56,189,248,.3)" />
              <div style="text-align:left">
                <div style="font-size:15px;line-height:1.2;color:#ffffff;font-weight:800">BlockShift Arena</div>
                <div style="font-size:12px;line-height:1.45;color:#dbeafe">Secure OTP delivery</div>
              </div>
            </div>
            <img src="${logoUrl}" alt="BlockShift Arena" width="248" style="max-width:100%;height:auto;display:block;margin:0 auto 16px;filter:drop-shadow(0 10px 28px rgba(0,0,0,.45))" />
            <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:#082f49;border:1px solid #38bdf8;font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#e0f2fe;font-weight:900">Arena Access</div>
            <h1 style="margin:18px 0 10px;font-size:30px;line-height:1.08;color:#ffffff;font-weight:900;text-shadow:0 3px 12px rgba(0,0,0,.45);text-align:center">${heading}</h1>
            <p style="margin:0 auto;max-width:430px;color:#f8fbff;font-size:16px;line-height:1.7;font-weight:600;text-align:center">Your secure code is ready. Enter it in BlockShift Arena to continue into the arena.</p>
          </div>
          <div style="padding:28px">
            <div style="margin:0 0 18px;padding:14px 16px;border-radius:16px;background:#082f49;border:1px solid rgba(125,211,252,.34);color:#effbff;font-size:14px;line-height:1.6;font-weight:600">
              This code expires in <strong style="color:#ffffff">${minutes} minute${minutes === 1 ? "" : "s"}</strong>.
            </div>
            <div style="font-size:38px;letter-spacing:.36em;font-weight:900;text-align:center;padding:22px 18px;border-radius:20px;background:linear-gradient(180deg, #041226, #081a33);border:2px solid #7dd3fc;color:#ffffff;text-shadow:0 0 20px rgba(125,211,252,.55);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08), 0 10px 32px rgba(8,145,178,.24)">${code}</div>
            <p style="margin:18px 0 0;color:#f8fbff;font-size:15px;line-height:1.7;font-weight:600">Keep this code private. BlockShift Arena support will never ask you to share it.</p>
            <p style="margin:12px 0 0;color:#d1d5db;font-size:14px;line-height:1.65">If you did not request this email, you can safely ignore it.</p>
          </div>
        </div>
        <p style="max-width:560px;margin:14px auto 0;text-align:center;color:#e0f2fe;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;text-shadow:0 2px 6px rgba(0,0,0,.35)">BlockShift Arena secure account system</p>
      </div>
    </div>
  `;
}
