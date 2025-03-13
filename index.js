// Importar las librerías necesarias
const venom = require('venom-bot');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Configuración de la base de datos SQLite
const DB_PATH = path.join(__dirname, 'chatbot.db');
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error al abrir la base de datos:', err.message);
    } else {
        console.log('Base de datos SQLite cargada correctamente.');
    }
});

// Crear tablas si no existen (tabla de usuarios y tabla de consultas)
db.run(`CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT,
    document TEXT,
    affiliation TEXT,
    lastInteraction INTEGER
)`);
db.run(`CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT,
    reason TEXT,
    timestamp INTEGER,
    FOREIGN KEY(user_phone) REFERENCES users(phone)
)`);

// Objeto en memoria para rastrear el estado de la conversación de cada usuario
const userSessions = {}; 

// Función para limpiar la sesión en memoria
function resetUserSession(userPhone) {
    delete userSessions[userPhone];
}

// Iniciar Venom-Bot
venom
  .create({
      session: 'chatbot-session', 
      multidevice: true,  
      headless: true,
      logQR: true,        
      autoClose: 0,       
      disableSpins: true,
      disableWelcome: true,
      useChrome: true
  })
  .then(client => start(client))
  .catch(error => {
      console.error('Error al inicializar Venom-Bot:', error);
      process.exit(1);
  });

function start(client) {
    console.log('¡Cliente Venom-Bot iniciado y listo para recibir mensajes!');

    client.onMessage(async (message) => {
        try {
            // Ignorar mensajes de grupos
            if (message.isGroupMsg) return;

            const from = message.from;                // "54911XXXXXXX@c.us"
            const userPhone = from.split('@')[0];     // "54911XXXXXXX"
            const currentTime = Date.now();

            // Obtener datos del usuario
            db.get("SELECT * FROM users WHERE phone = ?", [userPhone], async (err, userRow) => {
                if (err) {
                    console.error('Error consultando la BD:', err.message);
                    await client.sendText(from, "Lo siento, ocurrió un error interno. Intentalo más tarde.");
                    return;
                }

                // Determinar si es nueva sesión (inactividad > 2 minutos o usuario no existe)
                let isNewSession = false;
                if (userRow) {
                    const last = userRow.lastInteraction || 0;
                    const diffMinutes = (currentTime - last) / 1000 / 60;
                    if (diffMinutes > 2) isNewSession = true;
                } else {
                    isNewSession = true;
                }

                // Actualizar la última interacción
                if (userRow) {
                    db.run("UPDATE users SET lastInteraction = ? WHERE phone = ?", [currentTime, userPhone]);
                }

                // Manejo de nueva sesión
                if (isNewSession) {
                    resetUserSession(userPhone);

                    // Si el usuario no existe o sus datos están incompletos (sin name/document)
                    if (!userRow || !userRow.name || !userRow.document) {
                        await client.sendText(from, "*Bienvenido/a!* Soy ROCKY el asistente de AOMA Seccional Buenos Aires.\nAntes de continuar, necesito actualizar tus datos.");
                        if (!userRow) {
                            // Crear registro vacío si no existe
                            db.run(
                              "INSERT OR REPLACE INTO users(phone, name, document, affiliation, lastInteraction) VALUES (?, ?, ?, ?, ?)", 
                              [userPhone, null, null, null, currentTime]
                            );
                        }
                        // Si no tiene nombre, pedir nombre
                        if (!userRow || !userRow.name) {
                            await client.sendText(from, "Por favor, indicame tu *nombre completo*:");
                            userSessions[userPhone] = { state: 'awaiting_name' };
                            return;
                        } 
                        // Si tiene nombre pero no documento, pedir documento
                        else if (!userRow.document) {
                            userSessions[userPhone] = { state: 'awaiting_document' };
                            await client.sendText(from, "Por favor, indicame tu *número de documento*:");
                            return;
                        }
                    }

                    // Si el usuario ya tiene nombre y documento, mostrar datos y pedir confirmación
                    if (userRow && userRow.name && userRow.document) {
                        const infoMsg = `*Hola de nuevo* Soy ROCKY el asistente de AOMA Seccional Buenos Aires\n` +
                                        `Estos son los datos que tengo almacenados:\n\n` +
                                        `- *Nombre:* ${userRow.name}\n` +
                                        `- *Documento:* ${userRow.document}\n` +
                                        `- *Afiliación:* ${userRow.affiliation ? userRow.affiliation : 'Ninguna'}\n\n` +
                                        "¿Son correctos?";
                        await client.sendText(from, infoMsg);
                        userSessions[userPhone] = { state: 'awaiting_data_confirmation' };
                        return;
                    }
                }

                // Continuar con el flujo normal si no es nueva sesión
                const sessionState = userSessions[userPhone]?.state || null;

                switch (sessionState) {
                    case 'awaiting_name':
                        if (!message.body || !message.body.trim()) {
                            await client.sendText(from, "No detecté tu nombre. Por favor, ingresá tu *nombre completo*:");
                            return;
                        }
                        const name = message.body.trim();
                        db.run("UPDATE users SET name = ? WHERE phone = ?", [name, userPhone]);
                        await client.sendText(from, `Gracias, *${name}*. Ahora, por favor ingresá tu *número de documento*:`);
                        userSessions[userPhone].state = 'awaiting_document';
                        break;

                    case 'awaiting_document':
                        {
                            const doc = (message.body || "").trim();
                            if (!/^\d+$/.test(doc)) {
                                await client.sendText(from, "El documento debe contener solo números. Intentá de nuevo:");
                                return;
                            }
                            db.run("UPDATE users SET document = ? WHERE phone = ?", [doc, userPhone]);
                            
                            const affiliationMsg = `Ahora, por favor ingresá 1, 2, 3 o una combinacion de estos\n0 si no sos afiliada/o a ninguna.\n\n` +
                            `1 - Sindicato\n` +
                            `2 - Obra Social\n` +
                            `3 - Mutual\n` +
                            `0 - Ninguna` 

                            await client.sendText(from, affiliationMsg);
                            userSessions[userPhone].state = 'awaiting_affiliation';
                        }
                        break;
                        
                    case 'awaiting_affiliation':
                        {
                            let affiliation = '';
                            const affLower = message.body.trim().toLowerCase();

                            if (affLower.includes('1')) {affiliation += 'Sindicato ';}
                            if (affLower.includes('2')) {affiliation += 'Obra Social ';}
                            if (affLower.includes('3')) {affiliation += 'Mutual ';}
                            if (affLower.includes('0')) {affiliation = 'Ninguna';}
                            if (affiliation === '') {
                                // Si no se reconoce, se registra como "Ninguna" y se informa al usuario
                                affiliation = 'Ninguna';
                                await client.sendText(from, "No se reconoció la afiliación, se registrará como 'Ninguna'.");
                            }else{
                                await client.sendText(from, `Registre tu afiliación a ${affiliation}`);
                            }
                            // Guardar la afiliación en la BD
                            db.run("UPDATE users SET affiliation = ? WHERE phone = ?", [affiliation, userPhone]);
                            await client.sendText(from, `Por favor decime el motivo de tu consulta`);
                            userSessions[userPhone] = { state: 'awaiting_reason' };
                        }
                        break;
                    
                    case 'awaiting_reason':
                        {
                            const reasonText = (message.body || "").trim();
                            if (!reasonText) {
                                await client.sendText(from, "Por favor contame brevemente el *motivo de tu consulta*:");
                                return;
                            }
                            db.run(
                              "INSERT INTO consultations(user_phone, reason, timestamp) VALUES (?, ?, ?)", 
                              [userPhone, reasonText, Date.now()]
                            );
                            await client.sendText(from, "✅ *Gracias.* el motivo de tu consulta ha sido registrado. Un representante te contactará en breve.");
                            resetUserSession(userPhone);
                        }
                        break;

                    default:
                        // Sin estado específico
                        if (userRow && userRow.name && userRow.document && userRow.affiliation && !userSessions[userPhone]) {
                            await client.sendText(from, "Ya hemos registrado tus datos. Por favor esperá a que un representante responda. Si necesitás iniciar una nueva consulta, aguardá unos minutos e intentá nuevamente.");
                        } else {
                            // Iniciar el flujo desde cero
                            await client.sendText(from, "Hola. Para ayudarte, necesitamos algunos datos. Por favor, indicanos tu *nombre completo*:");
                            userSessions[userPhone] = { state: 'awaiting_name' };
                            db.run("INSERT OR REPLACE INTO users(phone, lastInteraction) VALUES (?, ?)", [userPhone, currentTime]);
                        }
                }
            });
        } catch (err) {
            console.error("Ocurrió un error en el manejo del mensaje:", err);
            await client.sendText(message.from, "Lo siento, ocurrió un error procesando su mensaje.");
        }
    });

    // Eventos adicionales de Venom
    client.onStateChange((state) => {
        console.log('Estado de conexión de Venom:', state);
        if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
            client.useHere();
        }
        if (state === 'UNPAIRED' || state === 'DISCONNECTED') {
            console.log('Sesión desconectada. Intentando reiniciar Venom...');
            venom.create().then(newClient => start(newClient));
        }
    });
}
