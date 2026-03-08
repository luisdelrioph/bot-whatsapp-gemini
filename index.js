// 1. IMPORTAR LIBRERÍAS
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 2. INICIALIZAR CONFIGURACIONES
const app = express();
app.use(bodyParser.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const VERIFY_TOKEN = "mi_token_secreto_123";

// 3. FUNCIÓN PARA DESCARGAR ARCHIVOS DE META
async function descargarArchivoDeWhatsApp(mediaId) {
    const token = process.env.WHATSAPP_TOKEN;

    try {
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v18.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const urlDescarga = urlResponse.data.url;
        
        // CRÍTICO: Limpiar el formato porque WhatsApp a veces añade parámetros extra que Gemini rechaza
        let mimeType = urlResponse.data.mime_type;
        mimeType = mimeType.split(';')[0]; // Toma solo "image/jpeg" y borra el resto

        const mediaResponse = await axios.get(urlDescarga, {
            headers: { 
                Authorization: `Bearer ${token}`,
                'User-Agent': 'curl/7.64.1'
            },
            responseType: 'arraybuffer'
        });

        // RADAR DE SEGURIDAD: Comprobar el peso real de lo que descargamos
        const fileSizeBytes = mediaResponse.data.byteLength || mediaResponse.data.length;
        console.log(`Archivo descargado de Meta. Tamaño: ${fileSizeBytes} bytes. Tipo limpio: ${mimeType}`);
        
        if (fileSizeBytes < 500) {
            const textoError = Buffer.from(mediaResponse.data).toString('utf-8');
            console.log("¡CUIDADO! Meta entregó un archivo muy pequeño. Podría ser un error oculto:", textoError);
        }

        const base64Data = Buffer.from(mediaResponse.data, 'binary').toString('base64');

        return {
            inlineData: {
                data: base64Data,
                mimeType: mimeType
            }
        };
    } catch (error) {
        console.error("Error descargando el archivo:", error.response ? error.response.data : error.message);
        throw error;
    }
}

// 4. FUNCIÓN PARA PREGUNTAR A GEMINI (TEXTO Y MULTIMEDIA)
async function analizarConGemini(prompt, archivoBase64 = null) {
    try {
        let result;
        
        if (archivoBase64) {
            console.log("Enviando archivo a Gemini. Tipo MIME limpio:", archivoBase64.inlineData.mimeType);
            
            // Volvemos al formato de arreglo simple que requiere la librería de Node.js
            result = await model.generateContent([prompt, archivoBase64]);
        } else {
            // Volvemos al formato de texto directo que ya comprobamos que funciona
            result = await model.generateContent(prompt);
        }
        
        return await result.response.text();
    } catch (error) {
        console.error("Error detallado al consultar a Gemini:", error.message || error);
        return "Lo siento, estoy teniendo problemas técnicos en este momento.";
    }
}

// 5. FUNCIÓN PARA ENVIAR EL MENSAJE DE VUELTA POR WHATSAPP
async function enviarMensajeWhatsApp(numeroDestino, textoMensaje) {
    try {
        const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;
        
        const data = {
            messaging_product: "whatsapp",
            to: numeroDestino,
            type: "text",
            text: { body: textoMensaje }
        };
        
        const config = {
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        };
        
        await axios.post(url, data, config);
        console.log(`Mensaje enviado exitosamente a ${numeroDestino}`);
    } catch (error) {
        console.error("Error enviando mensaje por WhatsApp:", error.response ? error.response.data : error.message);
    }
}

// 6. RUTA GET: Verificación del Webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 7. RUTA POST: Procesamiento de mensajes entrantes
app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    res.sendStatus(200);

    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const messageObj = body.entry[0].changes[0].value.messages[0];
            const phoneNumber = messageObj.from;

            console.log(`¡Alerta! Recibí un mensaje de tipo: ${messageObj.type}`);
                   
            let respuestaIA = "";

            try {
                if (messageObj.type === 'text') {
                    const mensajeUsuario = messageObj.text.body;
                    console.log(`Usuario (${phoneNumber}) dice: ${mensajeUsuario}`);
                    
                    respuestaIA = await analizarConGemini(mensajeUsuario);
                    console.log(`Gemini responde: ${respuestaIA}`);
                } 
                else if (messageObj.type === 'image' || messageObj.type === 'document') {
                    const mediaId = messageObj.type === 'image' ? messageObj.image.id : messageObj.document.id;
                    console.log(`Usuario (${phoneNumber}) envió un archivo con ID: ${mediaId}`);
                    
                    const archivoPreparado = await descargarArchivoDeWhatsApp(mediaId);
                    
                    let prompt = "¿Qué hay en este archivo? Hazme un resumen detallado.";
                    if (messageObj.type === 'image' && messageObj.image.caption) {
                        prompt = messageObj.image.caption;
                    } else if (messageObj.type === 'document' && messageObj.document.caption) {
                        prompt = messageObj.document.caption;
                    }

                    respuestaIA = await analizarConGemini(prompt, archivoPreparado);
                    console.log(`Gemini responde al archivo: ${respuestaIA}`);
                }

                if (respuestaIA !== "") {
                    await enviarMensajeWhatsApp(phoneNumber, respuestaIA);
                }

            } catch (error) {
                console.error("Error procesando el flujo del mensaje:", error);
            }
        }
    }
});

// 8. INICIAR EL SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor con Gemini corriendo en el puerto ${PORT}`);
});