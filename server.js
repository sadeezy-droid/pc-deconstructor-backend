const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Clean names down to key hardware model numbers for reliable retailer searching
function cleanPartForRetailerSearch(name) {
  if (!name) return '';
  
  let cleaned = name
    .replace(/\b(Intel|AMD|NVIDIA|GeForce|Radeon|Corsair|Kingston|Samsung|Crucial|MSI|ASUS|Gigabyte|EVGA|Thermaltake|DeepCool|Cooler Master|Western Digital|WD|Seagate)\b/gi, '')
    .replace(/\b(DDR4|DDR5|PCIe|NVMe|M\.2|SSD|RAM|MHz|CL\d+|Desktop|Gaming|Graphics|Card|Processor|Power Supply|Modular|80\+|Plus|Gold|Bronze|Chassis|Tower|Case)\b/gi, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Fallback to original name if cleaning stripped everything
  return cleaned.length >= 3 ? cleaned : name;
}

// Generate precise search URLs across Canadian hardware stores
function buildRetailerLinks(partName) {
  const keyword = cleanPartForRetailerSearch(partName);
  const encodedQuery = encodeURIComponent(keyword);

  return {
    canadaComputers: `https://www.canadacomputers.com/search/results_setting.php?keywords=${encodedQuery}`,
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
    let extractedExactPrice = null;

    if (process.env.SCRAPERAPI_KEY) {
      try {
        console.log('Fetching webpage via ScraperAPI...');
        const scraperApiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}`;
        const response = await axios.get(scraperApiUrl, { timeout: 15000 });

        if (response && response.data) {
          const $ = cheerio.load(response.data);

          // 1. Check for Best Buy / Next.js embedded JSON-LD or state payload before removing script tags
          $('script').each((_, el) => {
            const content = $(el).html() || '';
            if (content.includes('price') || content.includes('salePrice')) {
              try {
                // Regex search for JSON price key patterns like "price":2499.99 or "salePrice":2499.99
                const priceMatch = content.match(/"(?:salePrice|price|offerPrice)":\s*([\d\.]+)/i);
                if (priceMatch && priceMatch[1]) {
                  const p = parseFloat(priceMatch[1]);
                  if (p > 100) extractedExactPrice = p; // Avoid matching tax or rating numbers
                }
              } catch (e) {}
            }
          });

          // 2. Fallback to OpenGraph meta tag price if JSON script search yields nothing
          if (!extractedExactPrice) {
            const metaPrice = $('meta[property="product:price:amount"]').attr('content') || $('meta[property="og:price:amount"]').attr('content');
            if (metaPrice) extractedExactPrice = parseFloat(metaPrice);
          }

          $('script, style, svg, nav, footer, iframe').remove();
          pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 8000);
        }
      } catch (err) {
        console.warn('ScraperAPI fetch failed:', err.message);
      }
    }

    const prompt = `
    You are an expert PC hardware extractor.
    Target Prebuilt PC Link: "${cleanUrl}"
    Product Slug: "${cleanSlug}"
    Webpage Content: "${pageText.slice(0, 4000)}"
    ${extractedExactPrice ? `Exact Webpage Listed Price: $${extractedExactPrice} CAD` : ''}

    INSTRUCTIONS:
    1. Extract the PREBUILT SALE PRICE in CAD ($). ${extractedExactPrice ? `Use $${extractedExactPrice} CAD directly.` : ''}
    2. Extract individual hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    3. Output minimal, accurate part names for searching (e.g., "Core Ultra 7 265F" instead of "Intel Core Ultra 7 265F 20-Core Processor").
    4. Provide realistic individual retail price estimates in CAD ($) as plain numbers.
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
            prebuiltPriceCAD: { type: 'NUMBER' },
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

    const finalPrebuiltPrice = extractedExactPrice || Number(result.prebuiltPriceCAD) || 0;

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