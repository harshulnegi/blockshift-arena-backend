import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createApiRouter } from "../src/routes/api.js";

test("email auth, guest auth, session restore, otp, google login, and duplicate checks work", async (t) => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `pilot_${suffix}@example.com`;
  const handle = `Pilot ${suffix}`;
  const username = `pilot_${suffix}`;

  const registered = await postJson(baseUrl, "/api/auth/register", {
    name: handle,
    username,
    email,
    password: "strong-password-1",
    country: "IN"
  });
  assert.equal(registered.status, 200);
  assert.ok(registered.body.token);
  assert.equal(registered.body.profile.handle, username);
  assert.equal(registered.body.profile.name, handle);
  assert.equal(registered.body.profile.rating, 100);

  const duplicateEmail = await postJson(baseUrl, "/api/auth/register", {
    name: `Other ${suffix}`,
    username: `other_${suffix}`,
    email,
    password: "strong-password-1"
  });
  assert.equal(duplicateEmail.status, 409);
  assert.equal(duplicateEmail.body.error, "email_in_use");

  const duplicateHandle = await postJson(baseUrl, "/api/auth/register", {
    name: `Other ${suffix}`,
    username,
    email: `other_${suffix}@example.com`,
    password: "strong-password-1"
  });
  assert.equal(duplicateHandle.status, 409);
  assert.equal(duplicateHandle.body.error, "handle_in_use");

  const badLogin = await postJson(baseUrl, "/api/auth/login", { email, password: "wrong-password" });
  assert.equal(badLogin.status, 401);

  const login = await postJson(baseUrl, "/api/auth/login", { email, password: "strong-password-1" });
  assert.equal(login.status, 200);
  assert.equal(login.body.profile.id, registered.body.profile.id);

  const session = await getJson(baseUrl, "/api/auth/session", login.body.token);
  assert.equal(session.status, 200);
  assert.equal(session.body.profile.handle, username);
  assert.equal(session.body.profile.name, handle);

  const renamedHandle = `renamed_${suffix}`;
  const renamedName = `Renamed ${suffix}`;
  const renamed = await postJson(baseUrl, "/api/profile", { name: renamedName, handle: renamedHandle, country: "IN", bio: "" }, login.body.token);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.profile.handle, renamedHandle);
  assert.equal(renamed.body.profile.name, renamedName);
  const oldHandleReuse = await postJson(baseUrl, "/api/auth/register", {
    name: `Reuse ${suffix}`,
    username,
    email: `reuse_${suffix}@example.com`,
    password: "strong-password-1"
  });
  assert.equal(oldHandleReuse.status, 200);

  const signupOtpEmail = `signup_${suffix}@example.com`;
  const signupOtp = await postJson(baseUrl, "/api/auth/register/request", {
    name: `Signup ${suffix}`,
    username: `signup_${suffix}`,
    email: signupOtpEmail,
    password: "otp-password-1",
    country: "IN"
  });
  assert.equal(signupOtp.status, 200);
  assert.equal(signupOtp.body.purpose, "signup");
  assert.match(signupOtp.body.devOtp, /^\d{6}$/);
  const signupVerified = await postJson(baseUrl, "/api/auth/register/verify", {
    name: `Signup ${suffix}`,
    username: `signup_${suffix}`,
    email: signupOtpEmail,
    password: "otp-password-1",
    code: signupOtp.body.devOtp,
    country: "IN"
  });
  assert.equal(signupVerified.status, 200);
  assert.equal(signupVerified.body.profile.handle, `signup_${suffix}`);

  const resetOtp = await postJson(baseUrl, "/api/auth/password/reset/request", { email });
  assert.equal(resetOtp.status, 200);
  assert.equal(resetOtp.body.purpose, "password_reset");
  assert.match(resetOtp.body.devOtp, /^\d{6}$/);
  const resetLogin = await postJson(baseUrl, "/api/auth/password/reset/verify", {
    email,
    code: resetOtp.body.devOtp,
    password: "new-strong-password-1"
  });
  assert.equal(resetLogin.status, 200);
  assert.equal(resetLogin.body.profile.id, registered.body.profile.id);
  const oldPasswordLogin = await postJson(baseUrl, "/api/auth/login", { email, password: "strong-password-1" });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await postJson(baseUrl, "/api/auth/login", { email, password: "new-strong-password-1" });
  assert.equal(newPasswordLogin.status, 200);

  const search = await getJson(baseUrl, `/api/profile/search?q=${encodeURIComponent(username.slice(0, 8))}&limit=5`, login.body.token);
  assert.equal(search.status, 200);
  assert.ok(search.body.players.some((player) => player.handle === username));
  assert.ok(!search.body.players.some((player) => player.id === registered.body.profile.id));

  const otpEmail = `otp_${suffix}@example.com`;
  const otpRequest = await postJson(baseUrl, "/api/auth/otp/request", { email: otpEmail });
  assert.equal(otpRequest.status, 200);
  assert.match(otpRequest.body.devOtp, /^\d{6}$/);
  const otpLogin = await postJson(baseUrl, "/api/auth/otp/verify", {
    email: otpEmail,
    code: otpRequest.body.devOtp,
    handle: `Otp ${suffix}`
  });
  assert.equal(otpLogin.status, 200);
  assert.equal(otpLogin.body.profile.handle, `otp${suffix}`);

  const googleEmail = `google_${suffix}@example.com`;
  const googleLogin = await postJson(baseUrl, "/api/auth/google", {
    idToken: `dev-google:${googleEmail}`,
    name: `Google ${suffix}`,
    username: `google_${suffix}`
  });
  assert.equal(googleLogin.status, 200);
  assert.equal(googleLogin.body.profile.handle, `google_${suffix}`);
  assert.equal(googleLogin.body.profile.name, `Google ${suffix}`);

  const guestLogin = await postJson(baseUrl, "/api/auth/guest", {
    deviceId: `device_${suffix}`,
    name: `Guest Hero ${suffix}`,
    username: `gh_${suffix}`,
    country: "IN"
  });
  assert.equal(guestLogin.status, 200);
  assert.ok(guestLogin.body.token);
  assert.equal(guestLogin.body.profile.handle, `gh_${suffix}`);
  assert.equal(guestLogin.body.profile.name, `Guest Hero ${suffix}`);
  assert.equal(guestLogin.body.profile.rating, 100);
  assert.equal(guestLogin.body.profile.country, "IN");

  const guestSession = await getJson(baseUrl, "/api/auth/session", guestLogin.body.token);
  assert.equal(guestSession.status, 200);
  assert.equal(guestSession.body.profile.id, guestLogin.body.profile.id);

  const sameGuest = await postJson(baseUrl, "/api/auth/guest", {
    deviceId: `device_${suffix}`,
    name: `Guest Renamed ${suffix}`,
    username: `gr_${suffix}`,
    country: "IN"
  });
  assert.equal(sameGuest.status, 200);
  assert.equal(sameGuest.body.profile.id, guestLogin.body.profile.id);
  assert.equal(sameGuest.body.profile.handle, `gr_${suffix}`);
  assert.equal(sameGuest.body.profile.name, `Guest Renamed ${suffix}`);

  const guestBind = await postJson(baseUrl, "/api/auth/google/bind", {
    idToken: `dev-google:bound_${suffix}@example.com`
  }, sameGuest.body.token);
  assert.equal(guestBind.status, 200);
  assert.equal(guestBind.body.profile.id, guestLogin.body.profile.id);
  assert.equal(guestBind.body.profile.handle, `gr_${suffix}`);

  const boundGoogleLogin = await postJson(baseUrl, "/api/auth/google", {
    idToken: `dev-google:bound_${suffix}@example.com`,
    name: `Bound ${suffix}`,
    username: `bound_${suffix}`
  });
  assert.equal(boundGoogleLogin.status, 200);
  assert.equal(boundGoogleLogin.body.profile.id, guestLogin.body.profile.id);
});

async function postJson(baseUrl, path, body, token = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(baseUrl, path, token = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  return { status: response.status, body: await response.json() };
}
