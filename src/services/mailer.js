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
  const { logoUrl, backgroundUrl } = emailAssetUrls();
  const heading = `${otpPurposeLabel(purpose).replace(/^./, (c) => c.toUpperCase())} code`;
  return `
    <div style="margin:0;padding:0;background:#020617;color:#e5f6ff;font-family:Inter,Arial,sans-serif">
      <div style="padding:28px 14px;background:#020617 url('${backgroundUrl}') center top / cover no-repeat">
        <div style="max-width:560px;margin:0 auto;border:1px solid rgba(56,189,248,.6);border-radius:24px;overflow:hidden;background:rgba(2,6,23,.86);box-shadow:0 28px 80px rgba(8,145,178,.35)">
          <div style="padding:30px 28px 22px;text-align:center;background:linear-gradient(180deg, rgba(2,6,23,.18), rgba(2,6,23,.82)), url('${backgroundUrl}') center center / cover no-repeat;border-bottom:1px solid rgba(103,232,249,.28)">
            <img src="${logoUrl}" alt="BlockShift Arena" width="240" style="max-width:100%;height:auto;display:block;margin:0 auto 18px" />
            <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:rgba(14,165,233,.16);border:1px solid rgba(103,232,249,.35);font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#67e8f9;font-weight:800">Arena Access</div>
            <h1 style="margin:18px 0 10px;font-size:28px;line-height:1.08;color:#ffffff">${heading}</h1>
            <p style="margin:0 auto;max-width:420px;color:#d4e7ff;font-size:15px;line-height:1.6">Your secure code is ready. Enter it in BlockShift Arena to continue into the match queue.</p>
          </div>
          <div style="padding:28px">
            <div style="margin:0 0 18px;padding:12px 14px;border-radius:16px;background:rgba(8,47,73,.48);border:1px solid rgba(56,189,248,.22);color:#bfeaff;font-size:13px;line-height:1.55">
              This code expires in <strong style="color:#ffffff">${minutes} minute${minutes === 1 ? "" : "s"}</strong>.
            </div>
            <div style="font-size:36px;letter-spacing:.34em;font-weight:900;text-align:center;padding:20px 18px;border-radius:18px;background:linear-gradient(180deg, rgba(2,6,23,.96), rgba(7,17,31,.96));border:1px solid #38bdf8;color:#ffffff;text-shadow:0 0 20px rgba(34,211,238,.8);box-shadow:inset 0 0 0 1px rgba(125,211,252,.12)">${code}</div>
            <p style="margin:18px 0 0;color:#c7d2fe;font-size:14px;line-height:1.65">Keep this code private. BlockShift Arena support will never ask you to share it.</p>
            <p style="margin:12px 0 0;color:#94a3b8;font-size:13px;line-height:1.6">If you did not request this email, you can safely ignore it.</p>
          </div>
        </div>
        <p style="max-width:560px;margin:14px auto 0;text-align:center;color:#7dd3fc;font-size:12px;letter-spacing:.12em;text-transform:uppercase">BlockShift Arena secure account system</p>
      </div>
    </div>
  `;
}
