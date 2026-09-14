const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Clean part names to generate clean retailer queries
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

// Generate correct, up-to-date Canadian retailer search links
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
        // Detect JS-heavy sites like Best Buy to selectively enable render=true
        const needsJsRender = cleanUrl.toLowerCase().includes('bestbuy');
        const renderParam = needsJsRender ? '&render=true' : '';
        
        console.log(`Fetching ${cleanUrl} via ScraperAPI (JS Render: ${needsJsRender})...`);
        const scraperApiUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}${renderParam}`;
        
        // Increase timeout for JS-rendered requests (25s vs 15s)
        const timeoutMs = needsJsRender ? 25000 : 15000;
        const response = await axios.get(scraperApiUrl, { timeout: timeoutMs });

        if (response && response.data) {
          const $ = cheerio.load(response.data);

          // 1. Check for structured JSON-LD data
          $('script[type="application/ld+json"]').each((_, el) => {
            try {
              const jsonData = JSON.parse($(el).html() || '{}');
              
              const offers = jsonData.offers || (jsonData['@graph'] && jsonData['@graph'].find(o => o.offers)?.offers);
              if (offers) {
                const offerObj = Array.isArray(offers) ? offers[0] : offers;
                const price = offerObj.price || offerObj.lowPrice;
                if (price) extractedExactPrice = parseFloat(price);
              } else if (jsonData.price) {
                extractedExactPrice = parseFloat(jsonData.price);
              }
            } catch (e) {}
          });

          // 2. Fallback to OpenGraph / Schema Meta tags
          if (!extractedExactPrice) {
            const metaPrice = 
              $('meta[property="product:price:amount"]').attr('content') ||
              $('meta[property="og:price:amount"]').attr('content') ||
              $('meta[itemprop="price"]').attr('content');
            
            if (metaPrice) extractedExactPrice = parseFloat(metaPrice);
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
    1. Determine the exact LISTED PREBUILT PRICE in CAD ($). ${extractedExactPrice ? `The actual verified product price is $${extractedExactPrice} CAD.` : ''}
    2. Extract individual hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
    3. Keep part names clean and concise for retail searches (e.g., "Core Ultra 7 265F" or "Ryzen 7 5700").
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