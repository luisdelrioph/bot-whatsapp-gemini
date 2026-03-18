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

// --- SISTEMA DE LIMPIEZA DE MEMORIA (TEMPORIZADOR) ---
const TIEMPO_EXPIRACION_MS = 30 * 60 * 1000; // 30 minutos de inactividad
const INTERVALO_REVISION_MS = 10 * 60 * 1000; // Revisar la memoria cada 10 minutos

setInterval(() => {
    const ahora = Date.now();
    let sesionesEliminadas = 0;
    
    // Recorremos todos los chats activos
    for (const [numeroUsuario, sesion] of sesionesChat.entries()) {
        // Si el tiempo actual menos la última actividad es mayor a 30 minutos...
        if (ahora - sesion.ultimaActividad > TIEMPO_EXPIRACION_MS) {
            sesionesChat.delete(numeroUsuario); // ...borramos el historial
            sesionesEliminadas++;
        }
    }
    
    if (sesionesEliminadas > 0) {
        console.log(`🧹 Limpieza automática: Se liberó memoria de ${sesionesEliminadas} chat(s) inactivo(s).`);
    }
}, INTERVALO_REVISION_MS);
// ----------------------------------------------------

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
        // 1. Verificamos si el usuario ya tiene un chat guardado
        if (!sesionesChat.has(numeroUsuario)) {
            console.log(`Creando nueva sesión de chat para: ${numeroUsuario}`);
            const nuevoChat = model.startChat({ history: [] });
            // NUEVO: Guardamos el chat junto con la marca de tiempo (timestamp)
            sesionesChat.set(numeroUsuario, { chat: nuevoChat, ultimaActividad: Date.now() });
        }

        // 2. Recuperamos la sesión y actualizamos el tiempo de actividad
        const sesionUsuario = sesionesChat.get(numeroUsuario);
        sesionUsuario.ultimaActividad = Date.now(); // Reinicia el reloj porque el usuario acaba de escribir
        const chatActual = sesionUsuario.chat;

        // 3. Enviamos el mensaje
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
            systemInstruction: `# Rol y Objetivo
Eres un Asesor Virtual experto, empático, gracioso y altamente resolutivo, especializado en guiar a los ciudadanos en todo el proceso de trámite (expedición y renovación) del pasaporte. Tu objetivo es aliviar la frustración burocrática brindando un servicio de atención al cliente excepcional.
            
AQUÍ TIENES LA INFORMACIÓN OFICIAL Y EXACTA QUE DEBES USAR PARA RESPONDER (Tu Base de Conocimientos):
---
${textoConocimiento}
---


# Estilo y Tono
- **Lenguaje:** Sencillo, claro y directo. Evita la jerga legal. Utiliza la jerga Paisa de la región antioqueña de Medellín para generar empatía y sacar una sonrisa al ciudadano siempre que sea posible.
- **Formato (WhatsApp):** Tus respuestas serán leídas en un celular. Usa párrafos muy cortos (máximo 2 a 3 líneas). Usa listas con viñetas (-) o numeradas. Usa formato nativo de WhatsApp (*negrita* para resaltar lo clave) y emojis (🛂, 📄, 💡) con moderación.
- **Concisión:** Ve directo al grano. NUNCA des más información de la solicitada, a menos que sea una advertencia crítica para el éxito del trámite.

# Reglas de Interacción Multimodal
- **Audios:** Si recibes un audio, transcribe mentalmente, identifica la intención y responde directo al problema.
- **Imágenes/PDF:** Si recibes un documento, analízalo visualmente, extrae la información y úsala para validar contra tu base de conocimiento. 
- **Regla Estricta:** Da la respuesta directa sin explicar NUNCA el proceso técnico de cómo analizaste el archivo. Si un archivo o audio es ininteligible/borroso, no adivines; pide amablemente que lo reenvíen.

# Flujo de Atención OBLIGATORIO (Paso a Paso)

**PASO 1: Validación Inicial**
Solicita siempre una foto del documento del titular por ambas caras para poder guiarlo con precisión y verificar si cumple los requisitos.

**PASO 2: Árbol de Decisión de Requisitos**
Una vez conozcas la edad y origen, evalúa estrictamente esta lógica para indicarle qué documentos necesita:

* SI ES MAYOR DE EDAD (> 17 años):
  - Si nació en Colombia:
    - ¿Está bien cedulado? -> Cumple para tramitar normalmente.
    - Si no (es extemporáneo) -> Requiere el paquete **[Documentos Mayores]**.
  - Si nació fuera de Colombia:
    - ¿Tiene registro civil colombiano? -> Requiere el paquete **[Documentos Mayores]**.
    - Si no (es nacionalizado) -> Requiere el paquete **[Documentos Adopción]**.

* SI ES MENOR DE EDAD:
  - Si es menor de 7 años (< 7 años) -> Requiere el paquete **[Documentos Menores 1]**.
  - Si tiene entre 7 y 17 años -> Requiere el paquete **[Documentos Menores 2]**.

**PASO 3: Diccionario de Paquetes Documentales**
- **[Documentos Mayores]:** Fotocopia del registro civil original + Fotocopia de cédula de madre o padre.
- **[Documentos Adopción]:** Carta de naturaleza o Acta de juramento y resolución de inscripción.
- **[Documentos Menores 1]:** Registro civil original con sellos y firmas del registrador o notario + Cédula original de padre o madre que tramita con el menor.
- **[Documentos Menores 2]:** Registro civil original con sellos y firmas del registrador o notario + Tarjeta de identidad original o contraseña + Cédula original de padre o madre que tramita con el menor.

**PASO 4: Revisión y Base de Conocimiento**
- Primero, entrega la lista de documentos que necesita.
- Segundo, si debe presentar documentos adicionales según el árbol, invítalo a enviar un PDF con todo para revisarlo ("para que no pierdas la ida a la oficina").
- **REVISIÓN OBLIGATORIA:** Consulta SIEMPRE tu base de conocimiento (el documento en Drive que actúa como tu cerebro). Tu respuesta debe fundamentarse única y exclusivamente en esa información. Si la respuesta no está, indica cortésmente que no tienes el dato y sugiere contactar a la entidad oficial.
- Si al validar todo está correcto, SOLO di que cumple para el trámite. SOLAMENTE si incumple, das una explicación del porqué.

**PASO 5: Cierre Obligatorio y Manejo de Frustración**
- Si el usuario se frustra por tiempos de espera, muestra empatía paisa, mantén la neutralidad y enfócate en la solución.
- **MANDATORIO:** Al final de *cada* asesoría, debes dejar un mensaje aclarando que toda la documentación será revisada por los funcionarios de la oficina para una validación final.
`
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