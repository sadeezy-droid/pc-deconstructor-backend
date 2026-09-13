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
    const pathSegments = cleanUrl.split('/').filter(Boolean);
    const rawSlug = pathSegments[pathSegments.length - 2] || pathSegments[pathSegments.length - 1] || '';
    const cleanSlug = decodeURIComponent(rawSlug).replace(/[-_]/g, ' ');

    let pageText = '';

    // Attempt ScraperAPI retrieval if key exists
    if (process.env.SCRAPERAPI_KEY) {
      try {
        // Encode the target URL for ScraperAPI request
        const scraperApiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}&render=true`;

        const response = await axios.get(scraperApiUrl, { timeout: 20000 });

        if (response && response.data) {
          const $ = cheerio.load(response.data);
          $('script, style, svg, nav, footer, iframe').remove();
          pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 10000);
        }
      } catch (scraperErr) {
        console.warn('ScraperAPI request failed or timed out. Falling back to URL slug extraction:', scraperErr.message);
      }
    }

    const prompt = `
    You are an expert PC hardware component extractor.
    Target Prebuilt PC URL: "${cleanUrl}"
    URL Product Slug: "${cleanSlug}"
    Full Webpage Content: "${pageText.slice(0, 4000) || 'Scrape unavailable. Rely strictly on URL slug specs.'}"

    INSTRUCTIONS:
    Extract all individual hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    Provide estimated retail prices in CAD or USD for each component.
    `;

    // Execute Gemini API call with strict JSON response structure
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

    // Format search URLs for individual parts
    result.parts = result.parts.map(part => ({
      ...part,
      searchUrl: part.searchUrl || `https://www.google.com/search?q=buy+${encodeURIComponent(part.name)}`
    }));

    return res.json(result);

  } catch (error) {
    console.error('Extraction Failure:', error);
    return res.status(500).json({ error: 'Could not extract specs from that URL. Please try another product link.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));