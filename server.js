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

    // Clean tracking parameters and parse URL slug
    const cleanUrl = rawUrl.split('?')[0];
    const pathSegments = cleanUrl.split('/').filter(Boolean);
    const rawSlug = pathSegments[pathSegments.length - 2] || pathSegments[pathSegments.length - 1] || '';
    const cleanSlug = decodeURIComponent(rawSlug).replace(/[-_]/g, ' ');

    let pageText = '';

    // Fetch via ScraperAPI if key is available
    if (process.env.SCRAPERAPI_KEY) {
      try {
        console.log('Fetching webpage via ScraperAPI...');
        const scraperApiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}`;
        const response = await axios.get(scraperApiUrl, { timeout: 15000 });

        if (response && response.data) {
          const $ = cheerio.load(response.data);
          $('script:not([type="application/ld+json"]), style, svg, nav, footer, iframe').remove();
          pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 10000);
        }
      } catch (scraperErr) {
        console.warn('ScraperAPI error:', scraperErr.message);
      }
    }

    const prompt = `
    You are an expert PC hardware component extractor analyzing a prebuilt gaming PC listing.
    Target URL: "${cleanUrl}"
    Product Slug: "${cleanSlug}"
    Webpage Content: "${pageText.slice(0, 5000) || 'Deduce specs from product title slug.'}"

    INSTRUCTIONS:
    1. Identify the prebuilt system's title and its retail listing price in CAD ($).
    2. Extract/infer individual hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    3. Provide estimated individual retail prices in CAD ($) as raw numeric numbers (e.g. 250 for $250 CAD).
    4. Focus search options on major Canadian computer retailers (Canada Computers, Amazon Canada, Memory Express, Newegg Canada).
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            pcTitle: { type: 'STRING' },
            prebuiltPriceCAD: { type: 'NUMBER', description: 'Listed prebuilt retail price in CAD (number only)' },
            parts: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  category: { type: 'STRING' },
                  name: { type: 'STRING' },
                  estimatedPriceCAD: { type: 'NUMBER', description: 'Individual part price in CAD (number only)' }
                },
                required: ['category', 'name', 'estimatedPriceCAD']
              }
            }
          },
          required: ['pcTitle', 'prebuiltPriceCAD', 'parts']
        }
      }
    });

    const result = JSON.parse(response.text);

    // Calculate total parts cost
    let totalPartsCostCAD = 0;
    
    result.parts = result.parts.map(part => {
      const priceNum = Number(part.estimatedPriceCAD) || 0;
      totalPartsCostCAD += priceNum;

      const encodedName = encodeURIComponent(part.name);
      
      return {
        ...part,
        estimatedPriceFormatted: `$${priceNum.toFixed(2)} CAD`,
        retailerLinks: {
          canadaComputers: `https://www.canadacomputers.com/search/results_setting.php?keywords=${encodedName}`,
          amazonCA: `https://www.amazon.ca/s?k=${encodedName}`,
          memoryExpress: `https://www.memoryexpress.com/Search/Products?Search=${encodedName}`,
          neweggCA: `https://www.newegg.ca/p/pl?d=${encodedName}`
        }
      };
    });

    const prebuiltPrice = Number(result.prebuiltPriceCAD) || 0;
    const priceDifference = prebuiltPrice - totalPartsCostCAD;

    // Build complete summary payload
    const finalResponse = {
      pcTitle: result.pcTitle,
      prebuiltPriceFormatted: prebuiltPrice > 0 ? `$${prebuiltPrice.toFixed(2)} CAD` : 'Price not found',
      totalPartsCostFormatted: `$${totalPartsCostCAD.toFixed(2)} CAD`,
      priceDifferenceFormatted: priceDifference >= 0 
        ? `+$${priceDifference.toFixed(2)} CAD (Prebuilt Premium)` 
        : `-$${Math.abs(priceDifference).toFixed(2)} CAD (DIY Savings)`,
      parts: result.parts
    };

    return res.json(finalResponse);

  } catch (error) {
    console.error('Extraction Failure:', error.message || error);
    return res.status(500).json({ error: 'Could not extract specs from that URL.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));