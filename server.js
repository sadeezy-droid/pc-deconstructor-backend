const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper to clean search keywords for Canadian retailers
function sanitizePartName(name) {
  if (!name) return '';
  return name
    .replace(/\b(DDR4|DDR5|PCIe|NVMe|SSD|RAM|MHz|CL\d+|8GB|16GB|32GB|64GB|1TB|2TB|Desktop|Gaming|Graphics|Card|Processor|Power Supply)\b/gi, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Generate active search links for major Canadian stores
function buildRetailerLinks(partName) {
  const cleanKeyword = sanitizePartName(partName) || partName;
  const encodedQuery = encodeURIComponent(cleanKeyword);

  return {
    canadaComputers: `https://www.canadacomputers.com/index.php?cPath=&sf=${encodedQuery}`,
    amazonCA: `https://www.amazon.ca/s?k=${encodedQuery}`,
    memoryExpress: `https://www.memoryexpress.com/Search/Products?Search=${encodedQuery}`,
    neweggCA: `https://www.newegg.ca/p/pl?d=${encodedQuery}`
  };
}

app.post('/api/breakdown', async (req, res) => {
  try {
    const rawUrl = req.body.url;
    if (!rawUrl) return res.status(400).json({ error: 'URL is required' });

    const cleanUrl = rawUrl.split('?')[0];
    const pathSegments = cleanUrl.split('/').filter(Boolean);
    const rawSlug = pathSegments[pathSegments.length - 2] || pathSegments[pathSegments.length - 1] || '';
    const cleanSlug = decodeURIComponent(rawSlug).replace(/[-_]/g, ' ');

    let pageText = '';
    let extractedMetaPrice = null;

    // Fetch via ScraperAPI if configured
    if (process.env.SCRAPERAPI_KEY) {
      try {
        console.log('Fetching page content via ScraperAPI...');
        const scraperApiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}`;
        const response = await axios.get(scraperApiUrl, { timeout: 15000 });

        if (response && response.data) {
          const $ = cheerio.load(response.data);

          // Attempt structured JSON-LD or Meta extraction for accurate prebuilt price
          $('script[type="application/ld+json"]').each((_, el) => {
            try {
              const json = JSON.parse($(el).html());
              const offers = json.offers || (json['@graph'] && json['@graph'].find(i => i.offers)?.offers);
              if (offers) {
                const price = Array.isArray(offers) ? offers[0]?.price : offers.price;
                if (price) extractedMetaPrice = parseFloat(price);
              }
            } catch (e) {}
          });

          if (!extractedMetaPrice) {
            const metaPrice = $('meta[property="product:price:amount"]').attr('content') || $('meta[property="og:price:amount"]').attr('content');
            if (metaPrice) extractedMetaPrice = parseFloat(metaPrice);
          }

          $('script, style, svg, nav, footer, iframe').remove();
          pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 8000);
        }
      } catch (err) {
        console.warn('ScraperAPI error:', err.message);
      }
    }

    const prompt = `
    You are an expert PC hardware component deconstructor.
    Target Prebuilt PC URL: "${cleanUrl}"
    Product Title/Slug: "${cleanSlug}"
    Page Content: "${pageText.slice(0, 4000)}"
    ${extractedMetaPrice ? `Explicit Webpage Listing Price: $${extractedMetaPrice} CAD` : ''}

    INSTRUCTIONS:
    1. Extract the PREBUILT RETAIL SALE PRICE in CAD ($). Ignore strike-through/original prices or financing options (e.g. $50/mo). Use explicit listing price if available.
    2. Extract individual components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    3. Output concise, clean part names (e.g. "Intel Core Ultra 7 265F" instead of "Intel Core Ultra 7 265F 20-Core Processor").
    4. Provide realistic individual CAD retail price estimates (numeric only).
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
            prebuiltPriceCAD: { type: 'NUMBER', description: 'Listed prebuilt retail price in CAD (numeric only)' },
            parts: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  category: { type: 'STRING' },
                  name: { type: 'STRING' },
                  estimatedPriceCAD: { type: 'NUMBER' }
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

    // Overwrite with exact JSON-LD price if extracted directly
    const finalPrebuiltPrice = extractedMetaPrice || Number(result.prebuiltPriceCAD) || 0;

    let totalPartsCostCAD = 0;
    const formattedParts = result.parts.map(part => {
      const priceNum = Number(part.estimatedPriceCAD) || 0;
      totalPartsCostCAD += priceNum;

      return {
        ...part,
        estimatedPriceFormatted: `$${priceNum.toFixed(2)} CAD`,
        retailerLinks: buildRetailerLinks(part.name)
      };
    });

    const priceDifference = finalPrebuiltPrice - totalPartsCostCAD;

    return res.json({
      pcTitle: result.pcTitle,
      prebuiltPriceFormatted: finalPrebuiltPrice > 0 ? `$${finalPrebuiltPrice.toFixed(2)} CAD` : 'Price not found',
      totalPartsCostFormatted: `$${totalPartsCostCAD.toFixed(2)} CAD`,
      priceDifferenceFormatted: priceDifference >= 0
        ? `+$${priceDifference.toFixed(2)} CAD (Prebuilt Premium)`
        : `-$${Math.abs(priceDifference).toFixed(2)} CAD (DIY Savings)`,
      parts: formattedParts
    });

  } catch (error) {
    console.error('Extraction Failure:', error.message || error);
    return res.status(500).json({ error: 'Could not extract specs from that URL.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));