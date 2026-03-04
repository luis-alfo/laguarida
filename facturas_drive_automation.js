/**
 * Airtable Automation Script: facturas_Drive
 *
 * Migrado desde Make (Integromat) blueprint: facturas_Drive
 *
 * Flujo:
 *   1. Busca emails nuevos con label "💰 facturas" en Gmail
 *   2. Descarga los adjuntos de cada email
 *   3. Sube cada adjunto a Google Drive
 *   4. Comparte el archivo en Drive (anyone/reader)
 *   5. Crea un registro en Airtable con el link del archivo
 *   6. Añade label "💰 facturas/drive" al email procesado
 *
 * Configuración requerida (Input Variables del Automation):
 *   - GMAIL_ACCESS_TOKEN: OAuth2 token con scopes gmail.modify
 *   - DRIVE_ACCESS_TOKEN: OAuth2 token con scopes drive.file
 *
 * Nota: Los tokens OAuth2 deben renovarse externamente (p.ej. con un
 * servicio como Pipedream, n8n, o un script de refresh token).
 */

// ─── CONFIGURACIÓN ───────────────────────────────────────────────
const CONFIG = {
    gmail: {
        labelFacturas: 'Label_7109570217773719831',       // 💰 facturas
        labelDrive: 'Label_1719739415214180985',           // 💰 facturas/drive
    },
    drive: {
        folderId: '1JSdMECjTtLAA_irT5GRfVHmkVga07EDH',
    },
    airtable: {
        tableId: 'tbluQ9HMNk8iwDibG',
        fields: {
            factura: 'fldGDTeltM9jNaYnP',
            source: 'fldb0HSqLiCM48f1I',
            nombreFactura: 'fldfijvgbKd1hPoTM',
        },
    },
};

// ─── INPUT VARIABLES ─────────────────────────────────────────────
const inputConfig = input.config();
const GMAIL_TOKEN = inputConfig.GMAIL_ACCESS_TOKEN;
const DRIVE_TOKEN = inputConfig.DRIVE_ACCESS_TOKEN;

// ─── HELPERS ─────────────────────────────────────────────────────

function formatDate(date) {
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
}

async function gmailFetch(endpoint, options = {}) {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${GMAIL_TOKEN}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gmail API error (${response.status}): ${errorText}`);
    }
    return response.json();
}

async function driveFetch(endpoint, options = {}) {
    const baseUrl = options.uploadUrl
        ? 'https://www.googleapis.com/upload/drive/v3/'
        : 'https://www.googleapis.com/drive/v3/';
    const url = `${baseUrl}${endpoint}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${DRIVE_TOKEN}`,
            ...options.headers,
        },
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Drive API error (${response.status}): ${errorText}`);
    }
    return response.json();
}

// ─── PASO 1: Buscar emails con label "facturas" ─────────────────

async function getEmailsWithLabel(labelId, maxResults = 50) {
    const data = await gmailFetch(
        `messages?labelIds=${labelId}&maxResults=${maxResults}`
    );
    return data.messages || [];
}

async function getEmailDetail(messageId) {
    return gmailFetch(`messages/${messageId}?format=full`);
}

function extractEmailInfo(message) {
    const headers = message.payload.headers;
    const getHeader = (name) =>
        (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

    const fromRaw = getHeader('From');
    // Extraer nombre del formato "Nombre <email@example.com>"
    const fromNameMatch = fromRaw.match(/^"?([^"<]+)"?\s*</);
    const fromName = fromNameMatch ? fromNameMatch[1].trim() : fromRaw.split('@')[0];
    const fromEmailMatch = fromRaw.match(/<([^>]+)>/);
    const fromEmail = fromEmailMatch ? fromEmailMatch[1] : fromRaw;

    return {
        id: message.id,
        threadId: message.threadId,
        subject: getHeader('Subject'),
        fromName,
        fromEmail,
        internalDate: new Date(parseInt(message.internalDate)),
        labelIds: message.labelIds || [],
    };
}

// ─── PASO 2: Listar y descargar adjuntos ─────────────────────────

function getAttachmentParts(payload) {
    const parts = [];
    function walk(part) {
        if (part.filename && part.body && (part.body.attachmentId || part.body.data)) {
            parts.push({
                filename: part.filename,
                mimeType: part.mimeType,
                attachmentId: part.body.attachmentId,
                size: part.body.size,
            });
        }
        if (part.parts) {
            part.parts.forEach(walk);
        }
    }
    walk(payload);
    return parts;
}

async function downloadAttachment(messageId, attachmentId) {
    const data = await gmailFetch(
        `messages/${messageId}/attachments/${attachmentId}`
    );
    // Gmail devuelve base64url, convertimos a base64 estándar
    return data.data.replace(/-/g, '+').replace(/_/g, '/');
}

// ─── PASO 3: Subir a Google Drive ────────────────────────────────

async function uploadToDrive(filename, base64Data, mimeType, folderId) {
    const metadata = {
        name: filename,
        parents: [folderId],
    };

    // Usar multipart upload
    const boundary = 'airtable_script_boundary';
    const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    // Construir multipart body manualmente
    const metadataPart = JSON.stringify(metadata);
    const encoder = new TextEncoder();

    const preamble = encoder.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    );
    const postamble = encoder.encode(`\r\n--${boundary}--`);
    const base64Bytes = encoder.encode(base64Data);

    const body = new Uint8Array(preamble.length + base64Bytes.length + postamble.length);
    body.set(preamble, 0);
    body.set(base64Bytes, preamble.length);
    body.set(postamble, preamble.length + base64Bytes.length);

    const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${DRIVE_TOKEN}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: body,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Drive upload error (${response.status}): ${errorText}`);
    }
    return response.json();
}

// ─── PASO 4: Compartir archivo en Drive ──────────────────────────

async function shareFile(fileId) {
    const permission = {
        role: 'reader',
        type: 'anyone',
    };

    await driveFetch(`files/${fileId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(permission),
    });

    // Obtener el webContentLink
    const fileData = await driveFetch(
        `files/${fileId}?fields=webContentLink,webViewLink`
    );
    return fileData.webContentLink || fileData.webViewLink;
}

// ─── PASO 5: Crear registro en Airtable ──────────────────────────

async function createAirtableRecord(table, nombreFactura, fileUrl) {
    const record = await table.createRecordAsync({
        [CONFIG.airtable.fields.nombreFactura]: nombreFactura,
        [CONFIG.airtable.fields.source]: { name: 'Machine' },
        [CONFIG.airtable.fields.factura]: [
            { url: fileUrl, filename: nombreFactura },
        ],
    });
    return record;
}

// ─── PASO 6: Actualizar labels en Gmail ──────────────────────────

async function addLabelToEmail(messageId, labelId) {
    await gmailFetch(`messages/${messageId}/modify`, {
        method: 'POST',
        body: JSON.stringify({
            addLabelIds: [labelId],
        }),
    });
}

// ─── EJECUCIÓN PRINCIPAL ─────────────────────────────────────────

async function main() {
    const table = base.getTable(CONFIG.airtable.tableId);

    // 1. Obtener emails con label "facturas"
    console.log('Buscando emails con label "💰 facturas"...');
    const messages = await getEmailsWithLabel(CONFIG.gmail.labelFacturas);
    console.log(`Encontrados ${messages.length} email(s).`);

    if (messages.length === 0) {
        console.log('No hay emails nuevos para procesar.');
        return;
    }

    let processed = 0;
    let errors = 0;

    for (const msg of messages) {
        try {
            // Obtener detalle del email
            const fullMessage = await getEmailDetail(msg.id);
            const emailInfo = extractEmailInfo(fullMessage);

            // Verificar que no tenga ya el label "drive" (ya procesado)
            if (emailInfo.labelIds.includes(CONFIG.gmail.labelDrive)) {
                console.log(`⏭️ Email "${emailInfo.subject}" ya procesado, saltando.`);
                continue;
            }

            console.log(`📧 Procesando: "${emailInfo.subject}" de ${emailInfo.fromName}`);

            // 2. Listar adjuntos
            const attachments = getAttachmentParts(fullMessage.payload);
            if (attachments.length === 0) {
                console.log('  ⚠️ Sin adjuntos, saltando.');
                continue;
            }

            for (const att of attachments) {
                const dateStr = formatDate(emailInfo.internalDate);
                const filename = att.filename || `factura${emailInfo.fromEmail}.pdf`;
                const nombreFactura = `${dateStr}_${emailInfo.fromName}.pdf`;

                try {
                    // 3. Descargar adjunto y subir a Drive
                    console.log(`  📎 Subiendo adjunto: ${filename}`);
                    const base64Data = await downloadAttachment(msg.id, att.attachmentId);
                    const driveFile = await uploadToDrive(
                        filename,
                        base64Data,
                        att.mimeType || 'application/pdf',
                        CONFIG.drive.folderId
                    );
                    console.log(`  ✅ Subido a Drive: ${driveFile.id}`);

                    // 4. Compartir archivo
                    const shareLink = await shareFile(driveFile.id);
                    console.log(`  🔗 Link: ${shareLink}`);

                    // 5. Crear registro en Airtable
                    const recordId = await createAirtableRecord(
                        table,
                        nombreFactura,
                        shareLink
                    );
                    console.log(`  📝 Registro creado: ${recordId}`);
                } catch (uploadError) {
                    // Equivalente al error handler "Ignore" del blueprint
                    console.log(`  ⚠️ Error al procesar adjunto "${filename}": ${uploadError.message}`);
                    console.log('  Continuando con el siguiente...');
                }
            }

            // 6. Añadir label "drive" al email
            await addLabelToEmail(msg.id, CONFIG.gmail.labelDrive);
            console.log(`  🏷️ Label "facturas/drive" añadido.`);

            processed++;
        } catch (err) {
            console.log(`❌ Error procesando email ${msg.id}: ${err.message}`);
            errors++;
        }
    }

    console.log(`\n--- Resumen ---`);
    console.log(`Procesados: ${processed}`);
    console.log(`Errores: ${errors}`);
    console.log(`Saltados: ${messages.length - processed - errors}`);
}

await main();
