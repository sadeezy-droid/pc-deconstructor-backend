const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/breakdown', async (req, res) => {
  try {
    const rawUrl = req.body.url;
    if (!rawUrl) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Clean tracking parameters from URL
    const cleanUrl = rawUrl.split('?')[0];

    // Fetch page with realistic browser headers
    let pageText = '';
    try {
      const response = await axios.get(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      
      // Remove scripts, styles, and SVG junk to save token space
      $('script, style, svg, nav, footer, iframe').remove();
      pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 15000);
    } catch (fetchErr) {
      console.warn('Scraping direct HTML failed, passing URL directly to Gemini context:', fetchErr.message);
    }

    // Prepare prompt for Gemini
    const prompt = `
    Extract computer hardware specs from this URL and text context.
    Target URL: ${cleanUrl}
    Context Snippet: ${pageText || 'Extract based on model details found in the URL structure or product path.'}

    Return ONLY a valid JSON object matching this exact structure, with no markdown formatting or extra text:
    {
      "pcTitle": "Full Prebuilt PC Name",
      "parts": [
        {
          "category": "CPU / GPU / RAM / Storage / Motherboard / Power Supply / Case",
          "name": "Exact component model name",
          "estimatedPrice": "$XXX CAD or USD",
          "searchUrl": "https://www.google.com/search?q=buy+EXACT_COMPONENT_NAME"
        }
      ]
    }
    `;

    // Request response from Gemini 2.5 Flash
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const jsonText = response.text.trim();
    const result = JSON.parse(jsonText);

    res.json(result);

  } catch (error) {
    console.error('Extraction Error:', error);
    res.status(500).json({ error: 'Could not extract specs from that URL. Please try another product link.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});