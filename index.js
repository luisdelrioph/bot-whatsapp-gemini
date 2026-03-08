// 1. IMPORTAR LIBRERÍAS
require('dotenv').config(); // Carga las variables del archivo .env [cite: 167]
const express = require('express'); [cite: 168]
const bodyParser = require('body-parser'); [cite: 169]
const axios = require('axios'); // Para enviar peticiones HTTP a WhatsApp [cite: 170]
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Librería de Gemini [cite: 171, 172]

// 2. INICIALIZAR CONFIGURACIONES
const app = express(); [cite: 174]
app.use(bodyParser.json()); [cite: 175]

// Inicializar Gemini con tu API Key [cite: 176]
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); [cite: 177, 178]
// Usamos el modelo 1.5-flash porque soporta texto, imágenes y documentos de forma rápida
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// El token que inventamos para verificar el Webhook [cite: 179]
const VERIFY_TOKEN = "mi_token_secreto_123"; [cite: 180]

// 3. FUNCIÓN PARA DESCARGAR ARCHIVOS DE META
async function descargarArchivoDeWhatsApp(mediaId) {
    const token = process.env.WHATSAPP_TOKEN;

    try {
        // Paso 1: Pedirle a Meta la URL de descarga usando el mediaId
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v18.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const urlDescarga = urlResponse.data.url;
        const mimeType = urlResponse.data.mime_type;

        // Paso 2: Descargar el archivo binario desde esa URL
        const mediaResponse = await axios.get(urlDescarga, {
            headers: { 
                Authorization: `Bearer ${token}`,
                'User-Agent': 'curl/7.64.1' // A veces Meta rechaza bots sin User-Agent
            },
            responseType: 'arraybuffer'
        });

        // Paso 3: Convertir el archivo a Base64 para Gemini
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
            // Si hay un archivo, enviamos un array con el prompt y el archivo
            result = await model.generateContent([prompt, archivoBase64]);
        } else {
            // Si es solo texto
            result = await model.generateContent(prompt);
        }
        return await result.response.text();
    } catch (error) {
        console.error("Error al consultar a Gemini:", error); [cite: 196]
        return "Lo siento, estoy teniendo problemas técnicos en este momento."; [cite: 197, 198]
    }
}

// 5. FUNCIÓN PARA ENVIAR EL MENSAJE DE VUELTA POR WHATSAPP
async function enviarMensajeWhatsApp(numeroDestino, textoMensaje) { [cite: 202]
    try {
        // Construimos la URL de la API de Meta [cite: 204]
        const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`; [cite: 205, 206]
        
        // Configuramos el cuerpo del mensaje según la documentación de Meta [cite: 207, 208]
        const data = { [cite: 209]
            messaging_product: "whatsapp", [cite: 211]
            to: numeroDestino, [cite: 212]
            type: "text", [cite: 213]
            text: { body: textoMensaje } [cite: 214]
        }; [cite: 215]
        
        // Configuramos los permisos (El token de acceso) [cite: 216]
        const config = { [cite: 217]
            headers: { [cite: 219]
                'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, [cite: 220, 221]
                'Content-Type': 'application/json' [cite: 222]
            } [cite: 223]
        }; [cite: 224]
        
        // Enviamos la petición POST a Meta [cite: 225]
        await axios.post(url, data, config); [cite: 226]
        console.log(`Mensaje enviado exitosamente a ${numeroDestino}`); [cite: 227, 228]
    } catch (error) {
        console.error("Error enviando mensaje por WhatsApp:", error.response ? error.response.data : error.message); [cite: 230, 231]
    }
}

// 6. RUTA GET: Verificación del Webhook
app.get('/webhook', (req, res) => { [cite: 235]
    const mode = req.query['hub.mode']; [cite: 236]
    const token = req.query['hub.verify_token']; [cite: 237, 238]
    const challenge = req.query['hub.challenge']; [cite: 239]

    if (mode === 'subscribe' && token === VERIFY_TOKEN) { [cite: 240]
        res.status(200).send(challenge); [cite: 241]
    } else {
        res.sendStatus(403); [cite: 243]
    }
}); [cite: 245]

// 7. RUTA POST: Procesamiento de mensajes entrantes
app.post('/webhook', async (req, res) => { [cite: 247]
    const body = req.body; [cite: 248]
    
    // Apenas llega la petición, le respondemos 200 OK a Meta para que no asuma que falló [cite: 249]
    res.sendStatus(200); [cite: 250]

    if (body.object === 'whatsapp_business_account') { [cite: 251]
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) { [cite: 252, 253]
            // Extraemos los datos importantes [cite: 254]
            const messageObj = body.entry[0].changes[0].value.messages[0]; [cite: 256]
            const phoneNumber = messageObj.from; // Número de quien nos escribe [cite: 257, 258]

            // LÍNEA DE RADAR AQUÍ 
            console.log(`¡Alerta! Recibí un mensaje de tipo: ${messageObj.type}`);
            
            let respuestaIA = "";

            try {
                // Manejo de mensajes de solo texto
                if (messageObj.type === 'text') { [cite: 261, 262]
                    const mensajeUsuario = messageObj.text.body; [cite: 263]
                    console.log(`Usuario (${phoneNumber}) dice: ${mensajeUsuario}`); [cite: 263, 264]
                    
                    respuestaIA = await analizarConGemini(mensajeUsuario);
                    console.log(`Gemini responde: ${respuestaIA}`); [cite: 268, 269]
                } 
                // Manejo de imágenes y documentos
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

                // Enviar la respuestaIA de vuelta al usuario por WhatsApp
                if (respuestaIA !== "") {
                    await enviarMensajeWhatsApp(phoneNumber, respuestaIA); [cite: 277]
                }

            } catch (error) {
                console.error("Error procesando el flujo del mensaje:", error);
            }
        }
    }
});

// 8. INICIAR EL SERVIDOR
const PORT = process.env.PORT || 3000; [cite: 279]
app.listen(PORT, () => { [cite: 280]
    console.log(`Servidor con Gemini corriendo en el puerto ${PORT}`); [cite: 281, 282, 284]
}); [cite: 283]