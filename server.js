import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Extract SKU from Best Buy Canada URLs
function getBestBuySku(url) {
  try {
    const match = url.match(/\/(\d{8}|\d{7})(?:\?|$|\/)/);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

// Clean component names while PRESERVING exact technical terms extracted by Gemini
function cleanPartForRetailerSearch(name, category = '') {
  if (!name) return '';
  
  let cleaned = name
    .replace(/\b(Desktop|Gaming|Graphics Card|Processor|Modular|80\+|Plus|Gold|Bronze|Chassis|Tower|System|Kit|Pack)\b/gi, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const catLower = category.toLowerCase();

  if (catLower.includes('ram') || catLower.includes('memory')) {
    if (!/ram|ddr|memory/i.test(cleaned)) {
      cleaned += ' Desktop RAM';
    }
  } else if (catLower.includes('storage') || catLower.includes('ssd') || catLower.includes('drive')) {
    if (!/ssd|hdd|drive|storage|nvme|sata/i.test(cleaned)) {
      cleaned += ' SSD';
    }
  } else if (catLower.includes('power') || catLower.includes('psu')) {
    if (!/psu|power supply|watt|w\b/i.test(cleaned)) {
      cleaned += ' Power Supply';
    }
  } else if (catLower.includes('motherboard') || catLower.includes('mobo')) {
    if (!/motherboard|mobo|board/i.test(cleaned)) {
      cleaned += ' Motherboard';
    }
  }

  return cleaned.length >= 2 ? cleaned : name;
}

// Build precise retailer search links using category context
function buildRetailerLinks(partName, category = '') {
  const keyword = cleanPartForRetailerSearch(partName, category);
  const encodedQuery = encodeURIComponent(keyword);

  return {
    canadaComputers: `https://www.canadacomputers.com/en/search?s=${encodedQuery}&t=1`,
    amazonCA: `https://www.amazon.ca/s?k=${encodedQuery}`,
    memoryExpress: `https://www.memoryexpress.com/Search/Products?Search=${encodedQuery}`,
    neweggCA: `https://www.newegg.ca/p/pl?d=${encodedQuery}`
  };
}

// Main API Breakdown Endpoint
app.post('/api/breakdown', async (req, res) => {
  try {
    const rawUrl = req.body.url;
    const manualPrice = req.body.manualPrice ? parseFloat(req.body.manualPrice) : null;

    if (!rawUrl) {
      return res.status(400).json({ error: 'A product URL is required.' });
    }

    const cleanUrl = rawUrl.split('?')[0];
    const urlParts = cleanUrl.split('/');
    const cleanSlug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || '';

    let extractedExactPrice = manualPrice; // Priority 1: User Manual Input Override
    let pageText = '';

    // STEP 1: Direct Best Buy API bypass (runs ONLY if no manual price supplied)
    if (!extractedExactPrice && cleanUrl.includes('bestbuy.ca')) {
      const sku = getBestBuySku(cleanUrl);
      if (sku) {
        try {
          const bbyApi = await axios.get(`https://www.bestbuy.ca/api/v2/json/product/${sku}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            timeout: 6000
          });
          if (bbyApi.data) {
            extractedExactPrice = parseFloat(bbyApi.data.salePrice || bbyApi.data.regularPrice || 0);
          }
        } catch (e) {
          console.warn('Best Buy Direct API bypass failed or timed out. Falling back to ScraperAPI...');
        }
      }
    }

    // STEP 2: Fetch Page Content via ScraperAPI
    if (process.env.SCRAPERAPI_KEY) {
      try {
        const scraperUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(cleanUrl)}`;
        const response = await axios.get(scraperUrl, { timeout: 25000 });
        const $ = cheerio.load(response.data);

        // DOM Price parsing if price is still missing
        if (!extractedExactPrice) {
          const priceSelectors = [
            '[data-testid="customer-price"] span',
            '.price_F22T3',
            'span.a-price-whole',
            '.product-price',
            '[itemprop="price"]',
            '.price',
            '.product-price-value'
          ];

          for (const selector of priceSelectors) {
            const priceStr = $(selector).first().text().replace(/[^\d.]/g, '');
            if (priceStr && !isNaN(parseFloat(priceStr)) && parseFloat(priceStr) > 50) {
              extractedExactPrice = parseFloat(priceStr);
              break;
            }
          }
        }

        // Clean DOM body text for Gemini analysis
        $('script, style, noscript, nav, footer, header').remove();
        pageText = $('body').text().replace(/\s+/g, ' ').trim();

      } catch (err) {
        console.warn('ScraperAPI fetch failed:', err.message);
      }
    }

    // Fallback pageText to slug if scraping returned empty text
    if (!pageText) {
      pageText = `Product listing slug: ${cleanSlug.replace(/-/g, ' ')}`;
    }

    // STEP 3: Analyze Specs using Gemini LLM (Locked to gemini-3.6-flash)
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const prompt = `
You are an expert PC hardware extractor.
Target PC Link: "${cleanUrl}"
Product Title Slug: "${cleanSlug}"
Webpage Content: "${pageText.slice(0, 4500)}"
${extractedExactPrice ? `Verified Listed Page Price: $${extractedExactPrice} CAD` : ''}

INSTRUCTIONS:
1. Determine the exact LISTED PREBUILT PRICE in CAD ($). ${extractedExactPrice ? `Set "prebuiltPriceCAD" to exactly ${extractedExactPrice}.` : 'Look inside the text/title for the prebuilt price. If missing, estimate a realistic prebuilt price in CAD.'}
2. Extract individual hardware components (CPU, GPU, RAM, Storage, Motherboard, Power Supply, Case).
3. Component names MUST be clear and descriptive for retail searches:
   - Extract the EXACT generation and specs provided in the source text (e.g. DDR4 vs DDR5 vs DDR6, Gen3 vs Gen4 vs Gen5 NVMe, SATA SSD, etc.). DO NOT guess or default to DDR5 unless specified or explicitly clear from the platform.
   - Combine capacity and category into a complete search term (e.g. return "16GB DDR4 RAM" or "16GB DDR5 RAM", NEVER just "16GB").
   - Storage: Combine capacity and drive type (e.g. "1TB NVMe SSD" or "1TB SATA SSD", NEVER just "1TB").
   - GPU: Include full model (e.g., "GeForce RTX 4060 8GB").
   - CPU: Include exact model (e.g., "Core i5-12400F" or "Ryzen 7 7700X").
4. Provide realistic individual retail price estimates in CAD ($) as plain numbers.

Return ONLY JSON matching this structure:
{
  "pcTitle": "Full PC Name",
  "prebuiltPriceCAD": 1499.99,
  "parts": [
    {
      "category": "RAM",
      "name": "16GB DDR5 5600MHz RAM",
      "estimatedPriceCAD": 85.00
    }
  ]
}
`;

    const result = await model.generateContent(prompt);
    const jsonResponse = JSON.parse(result.response.text());

    // Calculate totals and format values safely
    let totalPartsCostCAD = 0;

    // Guaranteed Price Extraction Hierarchy
    let parsedGeminiPrice = parseFloat(jsonResponse.prebuiltPriceCAD);
    if (isNaN(parsedGeminiPrice)) parsedGeminiPrice = 0;

    const finalPrebuiltPrice = extractedExactPrice || parsedGeminiPrice || 0;

    const formattedParts = jsonResponse.parts.map(part => {
      const priceNum = Number(part.estimatedPriceCAD) || 0;
      totalPartsCostCAD += priceNum;

      return {
        category: part.category,
        name: part.name,
        estimatedPriceFormatted: `$${priceNum.toFixed(2)} CAD`,
        retailerLinks: buildRetailerLinks(part.name, part.category)
      };
    });

    const priceDiff = finalPrebuiltPrice - totalPartsCostCAD;
    const priceDiffFormatted = priceDiff >= 0 
      ? `+$${priceDiff.toFixed(2)} CAD (Prebuilt Premium)` 
      : `-$${Math.abs(priceDiff).toFixed(2)} CAD (DIY Savings)`;

    return res.json({
      pcTitle: jsonResponse.pcTitle,
      prebuiltPriceCAD: finalPrebuiltPrice, // Raw number for frontend state/editor
      prebuiltPriceFormatted: `$${finalPrebuiltPrice.toFixed(2)} CAD`, // Formatted display string
      totalPartsCostCAD: totalPartsCostCAD,
      totalPartsCostFormatted: `$${totalPartsCostCAD.toFixed(2)} CAD`,
      priceDifferenceFormatted: priceDiffFormatted,
      parts: formattedParts
    });

  } catch (error) {
    console.error('Error during breakdown process:', {
      message: error.message,
      status: error.status,
      responseData: error.response?.data
    });
    return res.status(500).json({ error: 'Failed to extract PC breakdown. Please verify the URL.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PC Deconstructor backend listening on port ${PORT}`);
});