const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.static('./')); 
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function callGroq(prompt) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        }
      }
    );
    return response.data.choices[0].message.content;
  } catch (error) {
    const errorDetails = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
    console.error('Groq API Error Details:', errorDetails);
    throw new Error(error.response?.data?.error?.message || 'Failed to generate response from Groq AI.');
  }
}

app.post('/api/perfect-resume', async (req, res) => {
  try {
    const { resumeText, jobDescription } = req.body;
    const prompt = `Act as an expert resume writer. Rewrite the following RESUME to perfectly match the JOB DESCRIPTION, aiming for a 100/100 ATS fit score. Reframe the user's actual experience using the exact keywords, tone, and requirements from the job description. Structure it professionally. Do not invent fake experience, but make it the strongest possible match.\n\nRESUME: ${resumeText}\nJOB: ${jobDescription}`;
    const result = await callGroq(prompt);
    res.json({ perfect_resume: result }); 
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/optimize', async (req, res) => {
  try {
    const { resumeText, jobDescription } = req.body;
    const prompt = `Optimize this resume for the job:\nRESUME: ${resumeText}\nJOB DESCRIPTION: ${jobDescription}\nProvide: optimized resume, 3 improvements, 3 gaps.`;
    const result = await callGroq(prompt);
    res.json({ optimized_resume: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/fit-score', async (req, res) => {
  try {
    const { resumeText, jobDescription } = req.body;
    const prompt = `Rate how well this resume matches the job on 0-100 scale.\nRESUME: ${resumeText}\nJOB: ${jobDescription}\nReply: XX/100 - reason`;
    const result = await callGroq(prompt);
    res.json({ fit_score: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cover-letter', async (req, res) => {
  try {
    const { resumeText, jobDescription } = req.body;
    const prompt = `Write a professional cover letter:\nRESUME: ${resumeText}\nJOB: ${jobDescription}`;
    const result = await callGroq(prompt);
    res.json({ cover_letter: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT} using Groq`));