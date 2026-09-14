const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function cleanPartForRetailerSearch(name) {
  if (!name) return '';
  let cleaned = name
    .replace(/\b(Intel|AMD|NVIDIA|GeForce|Radeon|Corsair|Kingston|Samsung|Crucial|MSI|ASUS|Gigabyte|EVGA|Thermaltake|DeepCool|Cooler Master|Western Digital|WD|Seagate)\b/gi, '')
    .replace(/\b(DDR4|DDR5|PCIe|NVMe|M\.2|SSD|RAM|MHz|CL\d+|Desktop|Gaming|Graphics|Card|Processor|Power Supply|Modular|80\+|Plus|Gold|Bronze|Chassis|Tower|Case)\b/gi, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 2 ? cleaned : name;
}

function buildRetailerLinks(partName) {
  const keyword = cleanPartForRetailerSearch(partName);
  const encodedQuery = encodeURIComponent(keyword);
  return {
    canadaComputers: `https://www.canadacomputers.com/en/search?s=${encodedQuery}&t=1`,
    amazonCA: `https://www.amazon.ca/s?k=${encodedQuery}`,
    memoryExpress: `https://www.memoryexpress.com/Search/Products?Search=${encodedQuery}`,
    neweggCA: `https://www.newegg.ca/p/pl?d=${encodedQuery}`
  };
}

// Helper to extract 8-digit Best Buy SKU
function getBestBuySku(url) {
  const match = url.match(/\/(\d{8}|\d{7})(?:\?|$)/);
  return match ? match[1] : null;
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
    let extractedExactPrice = req.body.manualPrice ? parseFloat(req.body.manualPrice) : null;

    // --- STEP 1: Direct Best Buy API Attempt ---
    if (!extractedExactPrice && cleanUrl.includes('bestbuy.ca')) {
      const sku = getBestBuySku(cleanUrl);
      if (sku) {
        try {
          console.log(`Attempting direct Best Buy Canada API call for SKU ${sku}...`);
          const bbyApi = await axios.get(`https://www.bestbuy.ca/api/v2/json/product/${sku}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json'
            },
            timeout: 6000
          });
          
          if (bbyApi.data) {
            extractedExactPrice = parseFloat(bbyApi.data.salePrice || bbyApi.data.regularPrice || 0);
            console.log(`Best Buy API success: Price found = $${extractedExactPrice}`);
          }
        } catch (e) {
          console.warn('Best Buy Direct API skipped or failed:', e.message);
        }
      }
    }

    // --- STEP 2: ScraperAPI Web Scraping Fallback ---
    if (process.env.SCRAPERAPI_KEY) {
      try {
        const needsJsRender = cleanUrl.toLowerCase().includes('bestbuy');
        const renderParam = needsJsRender ? '&render=true' : '';
        const scraperApiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}${renderParam}`;
        
        console.log(`Fetching ${cleanUrl} via ScraperAPI...`);
        const response = await axios.get(scraperApiUrl, { timeout: needsJsRender ? 25000 : 15000 });

        if (response && response.data) {
          const $ = cheerio.load(response.data);

          // Dedicated Best Buy DOM Selector Extraction
          if (!extractedExactPrice) {
            const testPrice = $('[data-testid="customer-price"] span').first().text() || 
                              $('[data-automation="product-price"]').first().text() ||
                              $('.price_F22T3').first().text();
            
            const priceMatch = testPrice.match(/[\d,]+\.\d{2}/);
            if (priceMatch) {
              extractedExactPrice = parseFloat(priceMatch[0].replace(/,/g, ''));
            }
          }

          // JSON-LD Fallback
          if (!extractedExactPrice) {
            $('script[type="application/ld+json"]').each((_, el) => {
              try {
                const jsonData = JSON.parse($(el).html() || '{}');
                const offers = jsonData.offers || (jsonData['@graph'] && jsonData['@graph'].find(o => o.offers)?.offers);
                if (offers) {
                  const offerObj = Array.isArray(offers) ? offers[0] : offers;
                  const price = offerObj.price || offerObj.lowPrice;
                  if (price) extractedExactPrice = parseFloat(price);
                }
              } catch (e) {}
            });
          }

          $('script, style, svg, nav, footer, iframe').remove();
          pageText = $('body').text().replace(/\s+/g, ' ').slice(0, 8000);
        }
      } catch (err) {
        console.warn('ScraperAPI fetch warning:', err.message);
      }
    }

    const prompt = `
    You are an expert PC hardware extractor.
    Target PC Link: "${cleanUrl}"
    Product Title Slug: "${cleanSlug}"
    Webpage Content: "${pageText.slice(0, 4000)}"
    ${extractedExactPrice ? `Verified Listed Page Price: $${extractedExactPrice} CAD` : ''}

    INSTRUCTIONS:
    1. Determine the exact LISTED PREBUILT PRICE in CAD ($). ${extractedExactPrice ? `Use $${extractedExactPrice} CAD directly.` : ''}
    2. Extract individual hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    3. Keep part names clean and concise for retail searches (e.g., "Core Ultra 7 265F").
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