const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/breakdown', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    $('script, style, noscript, nav, footer, header').remove();
    const pageText = $('body').text().replace(/\s+/g, ' ').substring(0, 10000);

    const partsSchema = {
      type: Type.OBJECT,
      properties: {
        pcTitle: { type: Type.STRING },
        parts: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              category: { type: Type.STRING },
              name: { type: Type.STRING },
              estimatedPrice: { type: Type.STRING },
              searchUrl: { type: Type.STRING }
            },
            required: ['category', 'name', 'estimatedPrice', 'searchUrl']
          }
        }
      },
      required: ['pcTitle', 'parts']
    };

    const prompt = `Analyze this webpage text for a prebuilt PC. Extract all listed components (CPU, GPU, RAM, Storage, Motherboard, PSU, Case, Cooler). For each item provide:
    1. Category
    2. Specific model name
    3. Estimated retail price (USD/CAD or N/A)
    4. A purchase search link on Amazon (https://www.amazon.com/s?k=QUERY)
    
    Content: ${pageText}`;

    const geminiRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: partsSchema,
      }
    });

    res.json(JSON.parse(geminiRes.text));
  } catch (err) {
    res.status(500).json({ error: 'Could not extract specs from that URL.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));