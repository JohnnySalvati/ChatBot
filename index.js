const venom = require('venom-bot');
// Si usamos SQLite:
const sqlite3 = require('sqlite3').verbose();
// Abrir o crear la base de datos SQLite (archivo local)
const db = new sqlite3.Database('./chatbot.db');

// Crear tabla si no existe
db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    whatsapp TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    apellido TEXT NOT NULL,
    dni TEXT NOT NULL,
    afiliaciones TEXT,
    ultima_interaccion TEXT
)`);

// Objeto para llevar el estado de conversación de cada usuario en memoria
let sessionState = {};  // p. ej., { "5491112345678": { step: 1, nombre: "...", apellido: "..." } }

// Iniciar el cliente Venom-Bot
venom.create({
  session: 'support-bot',  // nombre de sesión
  headless: true           // modo headless para entorno servidor (sin interfaz gráfica)
}).then(client => {
  console.log("Bot iniciado correctamente. Esperando mensajes...");
  
  client.onMessage(async message => {
    if (message.isGroupMsg) return;  // ignorar mensajes de grupos, solo chat directo
   
    // Obtener ID del remitente (número de WhatsApp)
    const senderId = message.from;           // ejemplo: "5491112345678@c.us"
    const phone = senderId.split('@')[0];    // solo el número, sin sufijo "@c.us"
    
    // Inicializar estado si es la primera interacción con este número
    if (!sessionState[phone]) {
      sessionState[phone] = { step: 1 };  // step 1: esperando nombre y apellido
      // Enviar saludo inicial y solicitud de nombre completo
      await client.sendText(senderId, 
        "¡Hola! 😊 Bienvenido/a. Para comenzar, por favor indícame tu *Nombre y Apellido*:");
      return; // esperar la respuesta del usuario
    }
    
    // Recuperar el estado actual del usuario
    const state = sessionState[phone];
    const userStep = state.step;
    const userMsg = message.body ? message.body.trim() : "";
    
    if (userStep === 1) {
      // Paso 1: tenemos que recibir Nombre y Apellido
      if (!userMsg || !userMsg.includes(" ")) {
        await client.sendText(senderId, "✋ *Nombre y Apellido inválidos.* Por favor ingresa ambos (ejemplo: Juan Pérez).");
        return;
      }
      // Separar nombre y apellido (tomar la primera palabra como nombre y el resto como apellido)
      const partes = userMsg.split(/\s+/, 2);
      state.nombre = partes[0];
      state.apellido = partes.length > 1 ? partes[1] : "";
      state.step = 2;  // siguiente paso: pedir DNI
      await client.sendText(senderId, `👍 Gracias *${state.nombre}*. Ahora envíame tu *DNI* (solo números, 7 u 8 dígitos):`);
      
    } else if (userStep === 2) {
      // Paso 2: validar DNI
      const dni = userMsg.replace(/\D/g, '');  // eliminar cualquier caracter no dígito
      if (!/^\d{7,8}$/.test(dni)) {
        await client.sendText(senderId, "❌ *DNI inválido.* Debe contener 7 u 8 dígitos numéricos. Intenta nuevamente:");
        return;
      }
      state.dni = dni;
      state.step = 3;  // siguiente paso: pedir afiliaciones
      // Enviar menú de opciones de afiliación
      await client.sendText(senderId, 
        "✅ DNI recibido. Ahora, selecciona tus opciones de afiliación (puedes elegir múltiples):\n" +
        "1. Obra Social\n" +
        "2. Sindicato\n" +
        "3. Mutual\n" +
        "4. Ninguna\n\n" +
        "_Responde con los números o nombres de las opciones, separados por coma si son varias. Ej: 1,3_");
      
    } else if (userStep === 3) {
      // Paso 3: procesar opciones de afiliación seleccionadas
      const input = userMsg.toLowerCase();
      const opciones = input.split(/[,\s]+/).filter(x => x); // separar por comas o espacios
      const seleccion = new Set();  // usar Set para evitar duplicados
      for (let opcion of opciones) {
        opcion = opcion.trim();
        if (["1", "obra", "social", "obra social"].includes(opcion)) {
          seleccion.add("Obra Social");
        }
        if (["2", "sindicato"].includes(opcion)) {
          seleccion.add("Sindicato");
        }
        if (["3", "mutual"].includes(opcion)) {
          seleccion.add("Mutual");
        }
        if (["4", "ninguna"].includes(opcion)) {
          seleccion.clear();       // si selecciona "Ninguna", descartamos las otras
          seleccion.add("Ninguna");
          break;
        }
      }
      if (seleccion.size === 0) {
        // No se entendió la respuesta
        await client.sendText(senderId, "⚠️ *No te he entendido.* Por favor responde con el número o el nombre de tu afiliación (ej: '1', 'Obra Social') y puedes incluir varias separadas por coma.");
        return;
      }
      // Guardar opciones seleccionadas y pasar a resumen
      state.afiliaciones = Array.from(seleccion);
      state.step = 4;
      // Construir mensaje de resumen
      const listaAfiliaciones = state.afiliaciones.join(", ");
      let resumen = "🤖 *Resumen de tus datos:* \n";
      resumen += `• *Nombre:* ${state.nombre}\n`;
      resumen += `• *Apellido:* ${state.apellido}\n`;
      resumen += `• *DNI:* ${state.dni}\n`;
      resumen += `• *Afiliaciones:* ${listaAfiliaciones || "Ninguna"}\n\n`;
      resumen += "¿*Confirmas* que estos datos son correctos? (Responde *Sí* para confirmar o *No* para reiniciar)";
      await client.sendText(senderId, resumen);
      
    } else if (userStep === 4) {
      // Paso 4: confirmación final
      const resp = userMsg.toLowerCase();
      if (resp === "si" || resp === "sí" || resp === "sí." || resp === "si.") {
        // Usuario confirma -> guardar en base de datos
        const nombre = state.nombre;
        const apellido = state.apellido;
        const dni = state.dni;
        const afiliaciones = state.afiliaciones ? state.afiliaciones.join(", ") : "";
        const fechaHora = new Date().toISOString();
        // Insertar o actualizar registro en DB
        db.run(`INSERT OR REPLACE INTO usuarios 
                (whatsapp, nombre, apellido, dni, afiliaciones, ultima_interaccion) 
                VALUES (?, ?, ?, ?, ?, ?)`,
               [phone, nombre, apellido, dni, afiliaciones, fechaHora],
               err => {
                 if (err) console.error("Error al guardar en DB:", err.message);
               });
        await client.sendText(senderId, `✅ *Gracias ${nombre}.* Tus datos han sido registrados correctamente. 📋 Un operador humano te contactará pronto para continuar con la asistencia. 🙌`);
        // Terminar sesión: borrar estado para este usuario
        delete sessionState[phone];
      } else if (resp === "no" || resp === "no.") {
        // Usuario no confirma -> reiniciar flujo
        await client.sendText(senderId, "🔄 De acuerdo, vamos a corregir la información. Empecemos de nuevo.\nPor favor, envíame tu *Nombre y Apellido*:");
        state.step = 1;
        // (Opcional: podríamos mantener los datos previos para reutilizar los correctos, pero aquí reiniciamos todo)
      } else {
        // Respuesta no reconocida, volver a pedir confirmación
        await client.sendText(senderId, "Por favor responde *Sí* para confirmar o *No* para reiniciar la captura de datos.");
      }
    }
  });
}).catch(err => {
  console.error("Error al iniciar Venom-Bot:", err);
});
