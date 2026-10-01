require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const { GROQ_API_KEY, BREVO_API_KEY, EMAIL_USER, JWT_SECRET } = process.env;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const FREE_CREDITS = 3;

if (!JWT_SECRET) console.warn('WARNING: set JWT_SECRET in environment variables.');
const SECRET = JWT_SECRET || crypto.randomBytes(32).toString('hex');

app.set('trust proxy', 1); // Needed on Render for rate limiting
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Securely serve the index.html file without exposing .env or server.js
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// In-memory stores (use a database like MongoDB for production)
const otpStore = new Map();   // email -> { otp, expires, attempts, lastSent }
const credits = new Map();    // email -> remaining free checks

const limiter = (max, minutes) =>
  rateLimit({ windowMs: minutes * 60 * 1000, max, message: { success: false, error: 'Too many requests. Try again later.' } });

const isEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) if (v.expires < now) otpStore.delete(k);
}, 60 * 1000).unref();

// Send email over HTTPS via Brevo
async function sendOtpEmail(to, otp) {
  if (!BREVO_API_KEY || !EMAIL_USER) {
    console.log(`[DEV] OTP for ${to}: ${otp}`);
    if (process.env.NODE_ENV === 'production') throw new Error('Email service not configured');
    return;
  }
  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: { name: 'ResumeAI', email: EMAIL_USER },
      to: [{ email: to }],
      subject: 'Your ResumeAI Verification Code',
      textContent: `Your 6-digit verification code is ${otp}. It expires in 10 minutes.`,
      htmlContent: `<div style="font-family:sans-serif;padding:24px;background:#090d16;color:#fff;border-radius:12px;max-width:420px;margin:auto">
        <h2 style="color:#818cf8;margin:0 0 12px">ResumeAI</h2>
        <p>Your verification code is:</p>
        <h1 style="background:#111827;padding:16px;text-align:center;color:#34d399;letter-spacing:8px;border-radius:8px">${otp}</h1>
        <p style="font-size:12px;color:#94a3b8">This code expires in 10 minutes. If you didn't request it, ignore this email.</p></div>`
    },
    { headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
}

app.get('/health', (req, res) => res.send('ok'));

app.post('/api/send-otp', limiter(10, 15), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });

  const existing = otpStore.get(email);
  if (existing && Date.now() - existing.lastSent < 60 * 1000) {
    return res.status(429).json({ success: false, error: 'Wait 60 seconds before requesting another code.' });
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  try {
    await sendOtpEmail(email, otp);
    otpStore.set(email, { otp, expires: Date.now() + 10 * 60 * 1000, attempts: 0, lastSent: Date.now() });
    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Could not send the email. Please try again later.' });
  }
});

app.post('/api/verify-otp', limiter(30, 15), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const otp = String(req.body.otp || '').trim();
  const rec = otpStore.get(email);

  if (!rec) return res.status(400).json({ success: false, error: 'No code requested for this email.' });
  if (Date.now() > rec.expires) {
    otpStore.delete(email);
    return res.status(400).json({ success: false, error: 'Code expired. Request a new one.' });
  }
  if (++rec.attempts > 5) {
    otpStore.delete(email);
    return res.status(429).json({ success: false, error: 'Too many wrong attempts. Request a new code.' });
  }
  const ok = otp.length === 6 && crypto.timingSafeEqual(Buffer.from(otp), Buffer.from(rec.otp));
  if (!ok) return res.status(400).json({ success: false, error: 'Incorrect code.' });

  otpStore.delete(email);
  if (!credits.has(email)) credits.set(email, FREE_CREDITS);
  const token = jwt.sign({ email }, SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, email, credits: credits.get(email) });
});

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    req.email = jwt.verify(token, SECRET).email;
    if (!credits.has(req.email)) credits.set(req.email, FREE_CREDITS);
    next();
  } catch {
    res.status(401).json({ error: 'Please verify your email again.' });
  }
}

app.get('/api/me', auth, (req, res) => res.json({ email: req.email, credits: credits.get(req.email) }));

async function callGroq(prompt) {
  try {
    const r = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.5 },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    return r.data.choices[0].message.content;
  } catch (e) {
    console.error('Groq error:', e.response?.data || e.message);
    throw new Error('AI processing failed. Please try again.');
  }
}

function aiRoute(buildPrompt) {
  return async (req, res) => {
    const resumeText = String(req.body.resumeText || '').trim();
    const jobDescription = String(req.body.jobDescription || '').trim();
    if (!resumeText || !jobDescription) return res.status(400).json({ error: 'Resume and job description are required.' });
    if (resumeText.length > 15000 || jobDescription.length > 10000) return res.status(400).json({ error: 'Text is too long.' });
    if ((credits.get(req.email) || 0) <= 0) return res.status(402).json({ error: 'No free checks left. Upgrade to Pro.', credits: 0 });

    try {
      const result = await callGroq(buildPrompt(resumeText, jobDescription));
      credits.set(req.email, credits.get(req.email) - 1); // charge only on success
      res.json({ result, credits: credits.get(req.email) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

const aiLimit = limiter(20, 10);
app.post('/api/optimize', auth, aiLimit, aiRoute((r, j) =>
  `Analyze this resume against the job description. Give: 1) ATS Fit Score (0-100), 2) missing keywords, 3) specific, prioritized improvement recommendations. Be concise and use plain text.\n\nResume:\n${r}\n\nJob Description:\n${j}`));

app.post('/api/perfect-resume', auth, aiLimit, aiRoute((r, j) =>
  `Rewrite this resume to match the job description for ATS. Use strong action verbs, single-column plain-text formatting and relevant keywords. Do NOT invent employers, degrees, dates or metrics; if a number is unknown, leave a [placeholder].\n\nResume:\n${r}\n\nJob Description:\n${j}`));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
