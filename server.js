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
    if (!rawUrl) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // 1. Clean tracking parameters and parse URL slug fallback
    const cleanUrl = rawUrl.split('?')[0];
    const pathSegments = cleanUrl.split('/').filter(Boolean);
    const rawSlug = pathSegments[pathSegments.length - 2] || pathSegments[pathSegments.length - 1] || '';
    const cleanSlug = decodeURIComponent(rawSlug).replace(/[-_]/g, ' ');

    let pageText = '';

    // 2. Route request through ScraperAPI if key is available
    if (process.env.SCRAPERAPI_KEY) {
      try {
        console.log('Sending request to ScraperAPI...');
        // Omit render=true to speed up response from 20s to ~3s
        const scraperApiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}`;

        const response = await axios.get(scraperApiUrl, { timeout: 15000 });

        if (response && response.data) {
          const $ = cheerio.load(response.data);
          $('script:not([type="application/ld+json"]), style, svg, nav, footer, iframe').remove();
          pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 10000);
          console.log('ScraperAPI successfully returned page content!');
        }
      } catch (scraperErr) {
        console.error('ScraperAPI Error Details:', scraperErr.response?.data || scraperErr.message);
      }
    } else {
      console.warn('SCRAPERAPI_KEY environment variable is missing in Render settings!');
    }

    // 3. Prompt Gemini 2.5 Flash
    const prompt = `
    You are an expert PC hardware component extractor.
    Target Prebuilt PC URL: "${cleanUrl}"
    Product Title Slug: "${cleanSlug}"
    Page Content: "${pageText.slice(0, 5000) || 'Scraped content empty. Deduce specs strictly from product title slug.'}"

    Instructions:
    Extract or infer individual hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    Provide estimated retail prices in CAD or USD for each component.
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

    result.parts = result.parts.map(part => ({
      ...part,
      searchUrl: part.searchUrl || `https://www.google.com/search?q=buy+${encodeURIComponent(part.name)}`
    }));

    return res.json(result);

  } catch (error) {
    console.error('Final Extraction Failure:', error.message || error);
    return res.status(500).json({ error: 'Could not extract specs from that URL. Please try another product link.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));