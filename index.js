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
    systemInstruction: 
});

const VERIFY_TOKEN = "mi_token_secreto_123";

// Mapa para guardar las sesiones de chat activas por número de teléfono
const sesionesChat = new Map();

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

// 4. FUNCIÓN PARA PREGUNTAR A GEMINI CON HISTORIAL DE CHAT
async function analizarConGemini(prompt, archivoBase64 = null, numeroUsuario) {
    try {
        // 1. Verificamos si el usuario ya tiene un chat guardado
        if (!sesionesChat.has(numeroUsuario)) {
            console.log(`Creando nueva sesión de chat para: ${numeroUsuario}`);
            // Iniciamos un chat en blanco con las reglas de sistema que ya configuramos
            const nuevoChat = model.startChat({ history: [] });
            sesionesChat.set(numeroUsuario, nuevoChat);
        }

        // 2. Recuperamos el chat de este usuario específico
        const chatActual = sesionesChat.get(numeroUsuario);

        // 3. Enviamos el mensaje (y el archivo si existe) a la conversación
        let result;
        if (archivoBase64) {
            console.log("Enviando archivo con contexto al chat...");
            result = await chatActual.sendMessage([prompt, archivoBase64]);
        } else {
            result = await chatActual.sendMessage(prompt);
        }
        
        return await result.response.text();
    } catch (error) {
        console.error("Error al consultar a Gemini con historial:", error.message || error);
        return "Lo siento, tuve un problema procesando tu mensaje. ¿Podrías repetirlo?";
    }
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
async function procesarAudioGemini(mediaId, numeroUsuario) {
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

             // 5. Enviar el audio al historial del usuario
     const prompt = "Por favor, responde a la consulta de este audio.";
     console.log("Enviando audio al historial de Gemini...");

     // Reutilizamos analizarConGemini para no perder el hilo de la conversación
     const respuestaIA = await analizarConGemini(prompt, audioPart, numeroUsuario);

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
                    
                    respuestaIA = await analizarConGemini(mensajeUsuario, null, phoneNumber);
                    console.log(`Gemini responde a texto: ${respuestaIA}`);
                } 
                // FLUJO 2: AUDIO (NUEVO)
                else if (messageObj.type === 'audio') {
                    const audioId = messageObj.audio.id;
                    console.log(`Usuario (${phoneNumber}) envió un audio con ID: ${audioId}`);
                    
                    respuestaIA = await procesarAudioGemini(audioId, phoneNumber);
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

                    respuestaIA = await analizarConGemini(prompt, archivoPreparado, phoneNumber);
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

// --- NUEVO SISTEMA DE CEREBRO DESDE GOOGLE DRIVE ---
let model; // Declaramos el modelo de forma global para que todo el código lo pueda usar

async function cargarConocimientoEIniciar() {
    try {
        // 1. Tu ID del documento de Google Drive
        const DOC_ID = 1JYgmoS6TiQPgvZLH-IOlipLoGXQWzOw9eEva8dYNOsQ; 
        
        // 2. URL secreta de Google para exportar el doc como texto plano
        const urlDescarga = `https://docs.google.com/document/export?format=txt&id=${DOC_ID}`;
        
        console.log("Descargando base de conocimientos desde Google Drive...");
        const respuesta = await axios.get(urlDescarga);
        const textoConocimiento = respuesta.data;

        // 3. Inyectar el texto descargado en Gemini
        model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: `Eres un asesor experto, rápido y amable especializado en guiar a las personas en el trámite de pasaportes.
            
AQUÍ TIENES LA INFORMACIÓN OFICIAL Y EXACTA QUE DEBES USAR PARA RESPONDER (Tu Base de Conocimientos):
---
${textoConocimiento}
---

`<rol>
Eres un Asesor Virtual experto, empático y altamente resolutivo, especializado en guiar a los usuarios en 
todo el proceso de trámite (expedición y renovación) del pasaporte. Tu objetivo es aliviar la frustración 
burocrática brindando un servicio de atención al cliente excepcional.
</rol>

<instrucciones_principales>
Debes cumplir estrictamente con las siguientes tareas en cada interacción:

1. REVISIÓN OBLIGATORIA: Antes de generar cualquier respuesta, DEBES consultar siempre tu base de conocimiento 
proporcionada. Tu respuesta debe estar fundamentada única y exclusivamente en esta información. Si la respuesta 
no está en tu base de conocimiento, indica cortésmente que no tienes esa información y sugiere al usuario 
contactar a la entidad oficial.
2. ORIENTACIÓN DOCUMENTAL: Guía a los usuarios sobre los requisitos, documentos, costos y pasos necesarios 
para obtener o renovar su pasaporte según su caso específico (mayor de edad, menor de edad, pérdida, etc.).
3. ANÁLISIS MULTIMODAL: Tienes la capacidad de recibir y procesar audios, imágenes y archivos PDF. 
   - Si el usuario envía un audio: Transcribe mentalmente la solicitud, identifica la intención y responde 
   al problema planteado.
   - Si el usuario envía una imagen o PDF (ej. un documento de identidad, un comprobante de pago o un error 
   en la plataforma): Analiza visualmente el documento, extrae la información relevante y úsala para guiar tu 
   respuesta o validar si el documento es correcto según tu base de conocimiento.
4. Tus respuestas serán leídas en la pantalla de un celular a través de WhatsApp. Por lo tanto, 
DEBES cumplir estas reglas estrictamente en TODAS tus respuestas:
-  Sé extremadamente conciso y ve directo al grano.
-  Usa párrafos muy cortos (máximo 2 o 3 líneas por párrafo).
-  Usa listas con viñetas (-) o numeradas si hay varios pasos o requisitos.
-  Usa el formato nativo de WhatsApp para resaltar información clave (*escribe entre asteriscos para usar negrita*).
-  Usa algunos emojis (📄, 📍, 💳) para hacer la lectura más visual, pero no exageres.
-  Si te envían un audio o un documento, da la respuesta de forma directa sin explicar el proceso técnico de cómo lo 
analizaste.
</instrucciones_principales>

<estilo_y_tono>
- Claridad extrema: Responde paso a paso. Usa listas numeradas para los procesos y viñetas para los requisitos.
- Lenguaje sencillo: Evita la jerga legal o burocrática. Explica los términos complejos de forma que cualquier 
persona pueda entenderlos.
- Concisión: Sé directo al grano. No añadas información de relleno que el usuario no haya solicitado, 
a menos que sea una advertencia crítica para el éxito del trámite.
</estilo_y_tono>

<casos_de_borde>
- Si un audio es ininteligible o un documento/imagen es borroso, no adivines. Pide amablemente al
 usuario que vuelva a enviar el archivo con mayor claridad.
- Si el usuario se muestra frustrado o enojado por los tiempos de espera del trámite gubernamental, 
muestra empatía, pero mantén la neutralidad y enfócate en lo que sí puedes solucionar.
</casos_de_borde>`
        });

        console.log("¡Cerebro de Gemini cargado exitosamente desde Drive!");

        // 4. Iniciar el servidor SOLO después de cargar la información
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Servidor de WhatsApp corriendo en el puerto ${PORT}`);
        });

    } catch (error) {
        console.error("Error crítico al descargar el Google Doc. Verifica que el enlace sea público:", error.message);
    }
}

// Ejecutar el arranque del bot
cargarConocimientoEIniciar();