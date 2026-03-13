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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto_123";

// Mapa para guardar las sesiones de chat activas por número de teléfono
const sesionesChat = new Map();

// Variable global para el modelo (se inicializará al descargar el Drive)
let model; 

// 3. FUNCIÓN PARA DESCARGAR ARCHIVOS DE META (Imágenes, Audio y Documentos)
async function descargarArchivoDeWhatsApp(mediaId) {
    const token = process.env.WHATSAPP_TOKEN;

    try {
        const urlResponse = await axios.get(
            `https://graph.facebook.com/v18.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const urlDescarga = urlResponse.data.url;
        
        // Limpiar el formato para Gemini
        let mimeType = urlResponse.data.mime_type;
        mimeType = mimeType.split(';')[0]; 

        const mediaResponse = await axios.get(urlDescarga, {
            headers: { 
                Authorization: `Bearer ${token}`,
                'User-Agent': 'curl/7.64.1'
            },
            responseType: 'arraybuffer'
        });

        const fileSizeBytes = mediaResponse.data.byteLength || mediaResponse.data.length;
        console.log(`Archivo descargado. Tamaño: ${fileSizeBytes} bytes. Tipo: ${mimeType}`);
        
        if (fileSizeBytes < 500) {
            console.log("¡CUIDADO! Archivo muy pequeño. Podría ser un error de Meta.");
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
        if (!sesionesChat.has(numeroUsuario)) {
            console.log(`Creando nueva sesión de chat para: ${numeroUsuario}`);
            const nuevoChat = model.startChat({ history: [] });
            sesionesChat.set(numeroUsuario, nuevoChat);
        }

        const chatActual = sesionesChat.get(numeroUsuario);

        let result;
        if (archivoBase64) {
            console.log("Enviando mensaje multimodal al chat...");
            result = await chatActual.sendMessage([prompt, archivoBase64]);
        } else {
            result = await chatActual.sendMessage(prompt);
        }
        
        return await result.response.text();
    } catch (error) {
        console.error("Error al consultar a Gemini:", error.message || error);
        return "Lo siento, tuve un problema procesando tu mensaje. ¿Podrías repetirlo?";
    }
} // <-- ¡Aquí estaba la llave extra en tu código original!

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
        console.log(`Mensaje enviado a ${numeroDestino}`);
    } catch (error) {
        console.error("Error enviando WhatsApp:", error.response ? error.response.data : error.message);
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
    // Devolver un 200 OK inmediato a Meta para evitar reintentos por timeout
    res.sendStatus(200);

    try {
        const body = req.body;
        
        if (body.object === 'whatsapp_business_account') {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                const messageObj = body.entry[0].changes[0].value.messages[0];
                const phoneNumber = messageObj.from;

                console.log(`\nMensaje recibido de tipo: ${messageObj.type}`);
                let respuestaIA = "";

                // FLUJO 1: TEXTO
                if (messageObj.type === 'text') {
                    const mensajeUsuario = messageObj.text.body;
                    respuestaIA = await analizarConGemini(mensajeUsuario, null, phoneNumber);
                } 
                // FLUJO 2: AUDIO
                else if (messageObj.type === 'audio') {
                    const audioId = messageObj.audio.id;
                    const audioPreparado = await descargarArchivoDeWhatsApp(audioId);
                    // Aseguramos que el mimeType sea compatible con notas de voz
                    audioPreparado.inlineData.mimeType = "audio/ogg"; 
                    const prompt = "Por favor, responde a la consulta de este audio.";
                    respuestaIA = await analizarConGemini(prompt, audioPreparado, phoneNumber);
                }
                // FLUJO 3: IMÁGENES Y DOCUMENTOS
                else if (messageObj.type === 'image' || messageObj.type === 'document') {
                    const mediaId = messageObj.type === 'image' ? messageObj.image.id : messageObj.document.id;
                    const archivoPreparado = await descargarArchivoDeWhatsApp(mediaId);
                    
                    let prompt = "Analiza este documento/imagen y dime si cumple con los requisitos para el trámite, o resume su contenido de forma breve.";
                    
                    // Extraer caption si existe, protegiendo contra undefined
                    if (messageObj.type === 'image' && messageObj.image?.caption) {
                        prompt = messageObj.image.caption;
                    } else if (messageObj.type === 'document' && messageObj.document?.caption) {
                        prompt = messageObj.document.caption;
                    }

                    respuestaIA = await analizarConGemini(prompt, archivoPreparado, phoneNumber);
                }

                // ENVIAR LA RESPUESTA AL USUARIO
                if (respuestaIA !== "") {
                    await enviarMensajeWhatsApp(phoneNumber, respuestaIA);
                }
            }
        }
    } catch (error) {
        console.error("Error crítico en el webhook POST:", error);
    }
});

// 8. CARGAR CONOCIMIENTO E INICIAR SERVIDOR
async function cargarConocimientoEIniciar() {
    try {
        // CORRECCIÓN: El ID debe ir entre comillas
        const DOC_ID = "1JYgmoS6TiQPgvZLH-IOlipLoGXQWzOw9eEva8dYNOsQ"; 
        const urlDescarga = `https://docs.google.com/document/export?format=txt&id=${DOC_ID}`;
        
        console.log("Descargando base de conocimientos desde Google Drive...");
        const respuesta = await axios.get(urlDescarga);
        const textoConocimiento = respuesta.data;

        // Inyectar el texto en Gemini
        model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: `Eres un asesor experto, rápido y amable especializado en guiar a las personas en el trámite de pasaportes.
            
AQUÍ TIENES LA INFORMACIÓN OFICIAL Y EXACTA QUE DEBES USAR PARA RESPONDER (Tu Base de Conocimientos):
---
${textoConocimiento}
---

<rol>
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
2. Si el usuario no es claro con su necesidad en el mensaje inicial PREGUNTA amablemente que necesita para 
poder asesorarlo.
3. SIEMPRE solicita antes de empezar la asesoria una foto o pdf de los documentos del titular (La persona que va
a tramitar el pasaporte) para validar la documentación requerida en ese caso específico.
3. ORIENTACIÓN DOCUMENTAL: Guía a los usuarios sobre los requisitos, documentos, costos y pasos necesarios 
para obtener o renovar su pasaporte según su caso específico (mayor de edad, menor de edad, pérdida, etc.).
4. ANÁLISIS MULTIMODAL: Tienes la capacidad de recibir y procesar audios, imágenes y archivos PDF. 
   - Si el usuario envía un audio: Transcribe mentalmente la solicitud, identifica la intención y responde 
   al problema planteado.
   - Si el usuario envía una imagen o PDF (ej. un documento de identidad, un comprobante de pago o un error 
   en la plataforma): Analiza visualmente el documento, extrae la información relevante y úsala para guiar tu 
   respuesta o validar si el documento es correcto según tu base de conocimiento.
5. Tus respuestas serán leídas en la pantalla de un celular a través de WhatsApp. Por lo tanto, 
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

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Servidor de WhatsApp corriendo en el puerto ${PORT}`);
        });

    } catch (error) {
        console.error("Error crítico al descargar el Google Doc. Verifica que el enlace sea PÚBLICO:", error.message);
    }
}

// Ejecutar el arranque del bot
cargarConocimientoEIniciar();