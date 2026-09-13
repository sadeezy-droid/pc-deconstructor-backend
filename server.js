const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/breakdown', async (req, res) => {
  try {
    const rawUrl = req.body.url;
    if (!rawUrl) return res.status(400).json({ error: 'URL is required' });

    // 1. Strip tracking params and parse URL slug
    const cleanUrl = rawUrl.split('?')[0];
    const pathSegments = cleanUrl.split('/').filter(Boolean);
    const rawSlug = pathSegments[pathSegments.length - 2] || pathSegments[pathSegments.length - 1] || '';
    const cleanSlug = decodeURIComponent(rawSlug).replace(/[-_]/g, ' ');

    // 2. Attempt scraping (isolated so failures never stop execution)
    let bodyText = '';
    try {
      const response = await axios.get(cleanUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 3500
      });
      if (response && response.data) {
        const $ = cheerio.load(response.data);
        $('script, style, svg, nav, footer, iframe').remove();
        bodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 4000);
      }
    } catch (err) {
      console.log('Direct scrape blocked. Falling back on URL slug parsing.');
    }

    // 3. Prompt Gemini with explicit fallback instruction
    const prompt = `
    Extract hardware components for this prebuilt PC.
    Target URL: "${cleanUrl}"
    Product Slug from URL: "${cleanSlug}"
    Page Content Snippet: "${bodyText.slice(0, 1500)}"

    Extract/infer components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    Provide price estimates in CAD or USD.
    `;

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
                required: ['category', 'name', 'estimatedPrice']
              }
            }
          },
          required: ['pcTitle', 'parts']
        }
      }
    });

    const result = JSON.parse(response.text);

    // Format search links
    result.parts = result.parts.map(part => ({
      ...part,
      searchUrl: part.searchUrl || `https://www.google.com/search?q=buy+${encodeURIComponent(part.name)}`
    }));

    return res.json(result);

  } catch (error) {
    console.error('Extraction Error:', error);
    return res.status(500).json({ error: 'Could not extract specs from that URL.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));