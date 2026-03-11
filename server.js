require("dotenv").config();
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const client = new Anthropic.default();

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
  // Remove scripts, styles, nav, footer to get cleaner content
  $("script, style, nav, footer, header, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  // Limit to 8000 chars to avoid bloating context
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

    // Stream the analysis from Claude
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

    const stream = await client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
    });

    let fullText = "";

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
        res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Analysis error:", err);
    let userMessage = "Analysis failed. Please try again.";
    if (err.status === 401 || err.message?.includes("authentication") || err.message?.includes("apiKey") || err.message?.includes("API key")) {
      userMessage = "Invalid or missing API key. Set ANTHROPIC_API_KEY in your .env file and restart the server.";
    } else if (err.status === 429) {
      userMessage = "Rate limit reached. Please wait a moment and try again.";
    } else if (err.status >= 500) {
      userMessage = "Claude API is temporarily unavailable. Please try again in a moment.";
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
