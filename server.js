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

    // Try basic HTML scraping
    let pageText = '';
    try {
      const response = await axios.get(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 8000
      });

      const $ = cheerio.load(response.data);
      $('script, style, svg, nav, footer, iframe').remove();
      pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 10000);
    } catch (fetchErr) {
      console.warn('Direct HTML scrape blocked/failed. Relying on Google Search grounding fallback.');
    }

    // Prepare prompt with Google Search tool enabled
    const prompt = `
    You are a hardware component extraction assistant.
    Target Prebuilt PC URL: ${cleanUrl}
    Scraped HTML Snippet: ${pageText || 'None (scrapes were blocked). Use Google Search to look up this exact URL or product slug to find the specs.'}

    Instructions:
    1. Extract or search for the exact components of this prebuilt computer (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    2. Respond with ONLY a raw JSON object matching this exact structure:
    {
      "pcTitle": "Full Product Name",
      "parts": [
        {
          "category": "CPU",
          "name": "Component Model Name",
          "estimatedPrice": "$XXX CAD",
          "searchUrl": "https://www.google.com/search?q=buy+COMPONENT_NAME"
        }
      ]
    }
    3. Do NOT wrap the JSON in markdown code blocks like \`\`\`json. Return pure JSON text only.
    `;

    // Request response using Google Search Grounding tool
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    let rawText = response.text.trim();
    
    // Clean potential markdown formatting if returned
    if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    const result = JSON.parse(rawText);
    res.json(result);

  } catch (error) {
    console.error('Extraction Error:', error);
    res.status(500).json({ error: 'Could not extract specs from that URL. Please check the link or try another.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});