import { Client } from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';
import dotenv from 'dotenv';
import { GoogleGenAI } from "@google/genai";

dotenv.config();
const genAI = new GoogleGenAI(process.env.GOOGLE_API_KEY);

async function generateAiResponse(prompt) {
    try {
        console.log(`Processando mensagem: ${prompt}`);
        const response = await genAI.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
        });
        const text = response.text;
        console.log(`Resposta gerada: ${text}`);
        return text;
    } catch (error) {
        console.error("Erro ao chamar a API Gemini:", error);
        if (error.message && error.message.includes('429')) {
            return "Desculpe, a cota da API foi excedida. Tente novamente mais tarde.";
        }
        return "Desculpe, houve um erro ao processar sua mensagem.";
    }
}

const client = new Client();

client.once('ready', () => {
    console.log('Cliente WhatsApp pronto!');
});

client.on('qr', (qr) => {
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('message', async message => {
    if (!message.body || message.fromMe) return;

    console.log(`Mensagem recebida de ${message.from}: ${message.body}`);
    const responseText = await generateAiResponse(message.body);

    if (responseText) {
        await client.sendMessage(message.from, responseText);
        console.log(`Resposta enviada para ${message.from}: ${responseText}`);
    } else {
        await client.sendMessage(message.from, "Desculpe, não consegui gerar uma resposta.");
    }
});

console.log('Iniciando o cliente WhatsApp...');
client.initialize().catch(err => {
    console.error("Erro ao iniciar o cliente WhatsApp:", err);
});