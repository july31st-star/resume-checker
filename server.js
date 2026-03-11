require("dotenv").config();
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const cheerio = require("cheerio");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function extractTextFromPDF(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}

async function fetchJobFromURL(url) {
  const response = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ResumeChecker/1.0)" },
    timeout: 10000,
  });
  const $ = cheerio.load(response.data);
  $("script, style, nav, footer, header, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.slice(0, 8000);
}

app.post("/api/analyze", upload.single("resume"), async (req, res) => {
  try {
    const { jobDescription, jobUrl } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Please upload a resume (PDF)." });
    }
    if (!jobDescription && !jobUrl) {
      return res.status(400).json({ error: "Please provide a job description or URL." });
    }

    // Extract resume text
    let resumeText;
    try {
      resumeText = await extractTextFromPDF(req.file.buffer);
    } catch {
      return res.status(400).json({ error: "Could not read PDF. Please ensure it's a valid PDF file." });
    }

    if (!resumeText || resumeText.trim().length < 50) {
      return res.status(400).json({ error: "Could not extract text from PDF. The file may be image-based or empty." });
    }

    // Get job description
    let jobText = jobDescription;
    if (jobUrl && !jobDescription) {
      try {
        jobText = await fetchJobFromURL(jobUrl);
      } catch {
        return res.status(400).json({ error: "Could not fetch job posting from URL. Try pasting the description instead." });
      }
    }

    if (!jobText || jobText.trim().length < 50) {
      return res.status(400).json({ error: "Job description is too short or empty." });
    }

    // Stream the analysis from Gemini
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const prompt = `You are an expert resume analyst and career coach. Analyze this resume against the job posting and provide a detailed match report.

## RESUME:
${resumeText.slice(0, 6000)}

## JOB POSTING:
${jobText.slice(0, 4000)}

Provide your analysis in the following JSON format ONLY (no extra text outside the JSON):

{
  "matchScore": <number 0-100>,
  "summary": "<2-3 sentence overall assessment>",
  "strengths": [
    "<strength 1>",
    "<strength 2>",
    "<strength 3>"
  ],
  "missingSkills": [
    {
      "skill": "<skill or requirement name>",
      "importance": "high|medium|low",
      "detail": "<why this matters for the role>"
    }
  ],
  "suggestions": [
    {
      "title": "<suggestion title>",
      "detail": "<specific actionable advice>"
    }
  ],
  "keywordGaps": ["<keyword1>", "<keyword2>", "<keyword3>"]
}

Be specific and actionable. Focus on what will genuinely improve the candidate's chances.`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContentStream(prompt);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Analysis error:", err);
    let userMessage = "Analysis failed. Please try again.";
    if (err.message?.includes("API key") || err.message?.includes("API_KEY") || err.status === 401 || err.status === 403) {
      userMessage = "Invalid or missing API key. Set GEMINI_API_KEY in your .env file and restart the server.";
    } else if (err.status === 429 || err.message?.includes("quota")) {
      userMessage = "Rate limit reached. Please wait a moment and try again.";
    }
    if (!res.headersSent) {
      res.status(500).json({ error: userMessage });
    } else {
      res.write(`data: ${JSON.stringify({ error: userMessage })}\n\n`);
      res.end();
    }
  }
});

// Export for Vercel serverless; listen only when run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Resume Checker running at http://localhost:${PORT}`);
  });
}

module.exports = app;
