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
  return `
    <div style="margin:0;padding:28px;background:#030712;color:#e5f6ff;font-family:Inter,Arial,sans-serif">
      <div style="max-width:520px;margin:0 auto;border:1px solid #0ea5e9;border-radius:14px;background:#07111f;padding:26px">
        <div style="font-size:14px;letter-spacing:.22em;text-transform:uppercase;color:#67e8f9;font-weight:800">BlockShift Arena</div>
        <h1 style="margin:14px 0 10px;font-size:26px;line-height:1.1;color:#ffffff">${otpPurposeLabel(purpose).replace(/^./, (c) => c.toUpperCase())} code</h1>
        <p style="margin:0 0 20px;color:#b6c7e6">Use this one-time code to enter the arena. It expires in ${minutes} minutes.</p>
        <div style="font-size:34px;letter-spacing:.32em;font-weight:900;text-align:center;padding:18px;border-radius:12px;background:#020617;border:1px solid #38bdf8;color:#ffffff;text-shadow:0 0 18px #22d3ee">${code}</div>
        <p style="margin:20px 0 0;color:#94a3b8;font-size:13px">If you did not request this code, you can safely ignore this email.</p>
      </div>
    </div>
  `;
}
