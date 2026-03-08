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
// Usando el modelo actualizado para soporte a largo plazo
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    systemInstruction: `Eres un asesor experto, rápido y amable especializado en guiar a las personas en el trámite de pasaportes.
Tus respuestas serán leídas en la pantalla de un celular a través de WhatsApp. Por lo tanto, DEBES cumplir estas reglas estrictamente en TODAS tus respuestas:
1. Sé extremadamente conciso y ve directo al grano.
2. Usa párrafos muy cortos (máximo 2 o 3 líneas por párrafo).
3. Usa listas con viñetas (-) o numeradas si hay varios pasos o requisitos.
4. Usa el formato nativo de WhatsApp para resaltar información clave (*escribe entre asteriscos para usar negrita*).
5. Usa algunos emojis (📄, 📍, 💳) para hacer la lectura más visual, pero no exageres.
6. Si te envían un audio o un documento, da la respuesta de forma directa sin explicar el proceso técnico de cómo lo analizaste.`
});

const VERIFY_TOKEN = "mi_token_secreto_123";

// 3. FUNCIÓN PARA DESCARGAR ARCHIVOS DE META (Imágenes y Documentos)
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
            result = await model.generateContent([prompt, archivoBase64]);
        } else {
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

// 6. FUNCIÓN PARA PROCESAR AUDIO CON GEMINI
async function procesarAudioGemini(mediaId) {
    // Usamos el token de las variables de entorno por seguridad
    const tokenWhatsApp = process.env.WHATSAPP_TOKEN; 
    
    try {
        // 1. Pedirle a WhatsApp la URL de descarga del audio
        const urlResponse = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${tokenWhatsApp}` }
        });
        const mediaUrl = urlResponse.data.url;

        // 2. Descargar el archivo de audio real
        const audioResponse = await axios.get(mediaUrl, {
            headers: { 'Authorization': `Bearer ${tokenWhatsApp}` },
            responseType: 'arraybuffer'
        });

        // 3. Convertir el audio a un formato que Gemini entienda (Base64)
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');

        // 4. Preparar el paquete para Gemini
        const audioPart = {
            inlineData: {
                data: base64Audio,
                mimeType: "audio/ogg" // Formato de notas de voz de WhatsApp
            }
        };

        // 5. Consultar a Gemini 
        const prompt = "Por favor, responde a la consulta de este audio.";
        
        console.log("Enviando audio a Gemini...");
        const result = await model.generateContent([prompt, audioPart]);
        const respuestaIA = result.response.text();
        
        return respuestaIA;

    } catch (error) {
        console.error("Error al procesar el audio:", error.response ? error.response.data : error.message);
        return "Lo siento, tuve un problema al escuchar tu nota de voz. ¿Podrías escribir tu consulta?";
    }
}

// 7. RUTA GET: Verificación del Webhook
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

// 8. RUTA POST: Procesamiento de mensajes entrantes
app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    // Devolver un 200 OK de inmediato a Meta para evitar reintentos
    res.sendStatus(200);

    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const messageObj = body.entry[0].changes[0].value.messages[0];
            const phoneNumber = messageObj.from;

            console.log(`\n¡Alerta! Recibí un mensaje de tipo: ${messageObj.type}`);
                   
            let respuestaIA = "";

            try {
                // FLUJO 1: TEXTO
                if (messageObj.type === 'text') {
                    const mensajeUsuario = messageObj.text.body;
                    console.log(`Usuario (${phoneNumber}) dice: ${mensajeUsuario}`);
                    
                    respuestaIA = await analizarConGemini(mensajeUsuario);
                    console.log(`Gemini responde a texto: ${respuestaIA}`);
                } 
                // FLUJO 2: AUDIO (NUEVO)
                else if (messageObj.type === 'audio') {
                    const audioId = messageObj.audio.id;
                    console.log(`Usuario (${phoneNumber}) envió un audio con ID: ${audioId}`);
                    
                    respuestaIA = await procesarAudioGemini(audioId);
                    console.log(`Gemini responde a audio: ${respuestaIA}`);
                }
                // FLUJO 3: IMÁGENES Y DOCUMENTOS
                else if (messageObj.type === 'image' || messageObj.type === 'document') {
                    const mediaId = messageObj.type === 'image' ? messageObj.image.id : messageObj.document.id;
                    console.log(`Usuario (${phoneNumber}) envió un archivo con ID: ${mediaId}`);
                    
                    const archivoPreparado = await descargarArchivoDeWhatsApp(mediaId);
                    
                    let prompt = "Analiza este documento/imagen y dime si cumple con los requisitos para el trámite, o resume su contenido de forma breve.";
                    if (messageObj.type === 'image' && messageObj.image.caption) {
                        prompt = messageObj.image.caption;
                    } else if (messageObj.type === 'document' && messageObj.document.caption) {
                        prompt = messageObj.document.caption;
                    }

                    respuestaIA = await analizarConGemini(prompt, archivoPreparado);
                    console.log(`Gemini responde al archivo: ${respuestaIA}`);
                }

                // ENVIAR LA RESPUESTA AL USUARIO
                if (respuestaIA !== "") {
                    await enviarMensajeWhatsApp(phoneNumber, respuestaIA);
                }

            } catch (error) {
                console.error("Error procesando el flujo del mensaje:", error);
            }
        }
    }
});

// 9. INICIAR EL SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor con Gemini corriendo en el puerto ${PORT}`);
});