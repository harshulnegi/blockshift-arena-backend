import jwt from "jsonwebtoken";

export function optionalAuth(req, _res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) req.user = verifyToken(token);
  next();
}

export function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}

export function signAppToken(user) {
  return jwt.sign(user, process.env.JWT_SECRET || "dev_secret_only", { expiresIn: "7d", issuer: "blockshift-arena" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || "dev_secret_only", { issuer: "blockshift-arena" });
  } catch {
    return null;
  }
}
