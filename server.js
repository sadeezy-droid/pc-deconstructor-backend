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

    // Clean tracking parameters and extract product slug from URL
    const cleanUrl = rawUrl.split('?')[0];
    const urlParts = cleanUrl.split('/').filter(Boolean);
    const productSlug = urlParts[urlParts.length - 2] || urlParts[urlParts.length - 1] || cleanUrl;
    const readableSlug = decodeURIComponent(productSlug).replace(/[-_]/g, ' ');

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
      pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 8000);
    } catch (fetchErr) {
      console.warn('Direct HTML scrape blocked. Extracting specs from URL slug and context.');
    }

    const prompt = `
    You are an expert PC hardware builder.
    Analyze the following prebuilt PC details and extract all hardware components into a structured list.

    Product Title/Slug from URL: "${readableSlug}"
    Target URL: "${cleanUrl}"
    Page Content Snippet: "${pageText.slice(0, 2000)}"

    Extract or infer these core parts: CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case.
    Provide realistic estimated retail prices in CAD/USD for each individual part.
    `;

    // Strict JSON Mode using responseSchema
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            pcTitle: { type: 'STRING' },
            parts: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  category: { type: 'STRING' },
                  name: { type: 'STRING' },
                  estimatedPrice: { type: 'STRING' },
                  searchUrl: { type: 'STRING' }
                },
                required: ['category', 'name', 'estimatedPrice', 'searchUrl']
              }
            }
          },
          required: ['pcTitle', 'parts']
        }
      }
    });

    const result = JSON.parse(response.text);

    // Ensure searchUrl is pre-filled if model leaves it basic
    result.parts = result.parts.map(part => ({
      ...part,
      searchUrl: part.searchUrl || `https://www.google.com/search?q=buy+${encodeURIComponent(part.name)}`
    }));

    res.json(result);

  } catch (error) {
    console.error('Extraction Error Details:', error);
    res.status(500).json({ error: 'Could not extract specs from that URL. Please try another product link.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});