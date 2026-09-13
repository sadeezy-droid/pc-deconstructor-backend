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

    // Safely attempt HTML scraping with absolute error isolation
    let pageText = '';
    try {
      const response = await axios.get(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        timeout: 4000
      });

      if (response && response.data) {
        const $ = cheerio.load(response.data);
        $('script, style, svg, nav, footer, iframe').remove();
        pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 5000);
      }
    } catch (scrapeErr) {
      console.log('Web fetch bypassed, utilizing URL slug context.');
    }

    const prompt = `
    You are an expert PC hardware builder.
    Extract the hardware components for this prebuilt computer.

    URL Slug: "${readableSlug}"
    Full Target URL: "${cleanUrl}"
    Page Context: "${pageText.slice(0, 1500)}"

    Instructions:
    Identify or infer the core hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    Provide estimated retail prices in CAD/USD for each individual component.
    `;

    // Execute Gemini call with strict JSON schema
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

    if (!response || !response.text) {
      throw new Error('Empty response from AI model.');
    }

    const result = JSON.parse(response.text);

    // Auto-generate search links for components
    result.parts = result.parts.map(part => ({
      ...part,
      searchUrl: part.searchUrl || `https://www.google.com/search?q=buy+${encodeURIComponent(part.name)}`
    }));

    return res.json(result);

  } catch (error) {
    console.error('Extraction Failure:', error.message || error);
    return res.status(500).json({ error: 'Could not extract specs from that URL. Please try another product link.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});