const FIREBASE_DB_URL = PropertiesService.getScriptProperties().getProperty("FIREBASE_DB_URL");
const SLACK_CLIENT_ID = PropertiesService.getScriptProperties().getProperty("SLACK_CLIENT_ID");
const SLACK_CLIENT_SECRET = PropertiesService.getScriptProperties().getProperty("SLACK_CLIENT_SECRET");
const REDIRECT_URI = PropertiesService.getScriptProperties().getProperty("REDIRECT_URI");

function sendNewEmailsToSlack() {

  const webhookUrl = getSlackWebhook();

  if (!webhookUrl) {
    throw new Error("Slack webhook URL not configured.");
  }
  const threads = GmailApp.search("is:inbox is:unread", 0, 10); // Only top 10 unread threads
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24*60 * 60 * 1000); // 24 hours ago
  const email = Session.getActiveUser().getEmail();

  for (const thread of threads) {
    const messages = thread.getMessages();

    for (const message of messages) {
      if (!message.isUnread()) continue;

      const receivedAt = message.getDate();
      if (receivedAt < cutoff) continue; // ⛔ Skip if message is older than 5 minutes

      const subject = message.getSubject();
      const sender = message.getFrom();
      const snippet = message.getPlainBody().substring(0, 200).replace(/\n/g, ' ');
      const messageId = message.getId();
      
      let gmailLink = "";
      // try {
      //   const rawMessageId = message.getHeader("Message-ID");
      //   if (rawMessageId) {
      //     const cleanedId = rawMessageId.replace(/[<>]/g, "").trim();
      //     if (cleanedId && cleanedId.includes("@")) {
      //       gmailLink = `https://mail.google.com/mail/u/0/?extsrc=sync&view=tl&search=inbox&q=rfc822msgid:${encodeURIComponent(cleanedId)}`;
      //     }
      //   }
      // } catch (e) {
      //   Logger.log("Error extracting Message-ID: " + e);
      // }

      // Fallback to basic URL if Message-ID was missing or malformed
      if (!gmailLink) {
        gmailLink = `https://mail.google.com/mail/u/0/#inbox/${message.getId()}`;
      }

      const receivedAtFormatted = Utilities.formatDate(receivedAt, Session.getScriptTimeZone(), "MMM d, yyyy 'at' hh:mm a");
      const value = `${messageId}##${email}##${sender}`
      const payload = {
        text: `━━━━━━━━━━━━ ✉ ${sender}━━━━━━━━━━━━`,
        attachments: [
          {
            callback_id: "email_actions", 
            color: "#36a64f",
            fields: [
              {
                title: "Subject",
                value: subject || "(No Subject)",
                short: true
              },
              {
                title: "Received",
                value: receivedAtFormatted,
                short: true
              },
              {
                title: "Snippet",
                value: snippet
              }
            ],
            actions: [
              {
                type: "button",
                text: "📬 View in Gmail",
                url: gmailLink
              },
              {
                type: "button",
                text: "🚫 Ignore",
                value: value,
                action_id: "ignore_email",
                name: "ignore_email"
              },
              {
                type: "button",
                text: "🗑️ Delete",
                style: "danger",
                value: value,
                action_id: "delete_email",
                name: "delete",
                confirm: {
                  title: "Confirm Delete",
                  text: "Are you sure you want to delete this email from Gmail?",
                  ok_text: "Yes",
                  dismiss_text: "Cancel"
                }
              }
            ]
          }
        ]
      };

      UrlFetchApp.fetch(webhookUrl, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload)
      });

      message.markRead(); // ✅ Mark processed message as read to avoid resending
    }
  }
}

function getFirebaseBaseDB(userEmail) {
  const url = userEmail.replaceAll('@','').replaceAll('.','');
  return FIREBASE_DB_URL + `/${url}/queue.json`;
}

function writeToQueue(userEmail, data) {
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(data)
  };
  const res = UrlFetchApp.fetch(getFirebaseBaseDB(userEmail), options);
  Logger.log(res.getContentText());
}

function readQueue(userEmail) {
  const res = UrlFetchApp.fetch(getFirebaseBaseDB(userEmail));
  const data = JSON.parse(res.getContentText());
  Logger.log(data);
  return data;
}

/**
 * Delete an item from Firebase queue
 * @param {string} key - Firebase key of the item
 */
function deleteQueueItem(userEmail, key) {
  const url = userEmail.replaceAll('@','').replaceAll('.','');
  const deleteUrl = `${FIREBASE_DB_URL}/${url}/queue/${key}.json`;
  try {
    UrlFetchApp.fetch(deleteUrl, { method: "delete" });
    Logger.log(`✅ Deleted queue item: ${key}`);
  } catch (err) {
    Logger.log(`❌ Failed to delete queue item ${key}: ${err.message}`);
  }
}

function doPost(e) {
  const payload = JSON.parse(e.parameter.payload);
  const action = payload.actions?.[0];
  const actionName = action?.name;
  const params = action.value.split('##');
  const messageId = params[0];

  const userEmail = params[1];
  if (!userEmail || !messageId) {
    return ContentService.createTextOutput("Missing user or messageId");
  }
  const sender = params[2];

  writeToQueue(userEmail, {
    email: userEmail,
    messageId: messageId,
    action: actionName,
    timestamp: Date.now()
  });

  if(actionName === "delete"){
    UrlFetchApp.fetch(payload.response_url, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            text: `🗑️ Deleted email from *${sender}*`,
            replace_original: true
          })
        });
  }
  else if (actionName === "ignore_email") {
    UrlFetchApp.fetch(payload.response_url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        text: `🚫 Ignored email from *${sender}*`,
        replace_original: true
      })
    });
  } else {
    UrlFetchApp.fetch(payload.response_url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        text: `⚠️ Unknown action: ${actionName}`,
        replace_original: false
      })
    });
  }

  return ContentService.createTextOutput("");
}

function doPost1(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput("No data received");
    }

    const params = e.parameter;

    if (params.payload) {
      const payload = JSON.parse(params.payload);
      const action = payload.actions?.[0];
      const actionName = action?.name;
      const messageId = action?.value;

      // ✅ Respond early to Slack to avoid timeout
      const response = ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);

      // ⚠️ Check for valid messageId
      if (!messageId) {
        UrlFetchApp.fetch(payload.response_url, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            text: `❌ Missing or invalid message ID.`,
            replace_original: true
          })
        });
        return response;
      }

      let message;
      try {
        message = GmailApp.getMessageById(messageId);
      } catch (err) {
        UrlFetchApp.fetch(payload.response_url, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            text: `❌ Email not found or already deleted.`,
            replace_original: true
          })
        });
        return response;
      }

      const from = message.getFrom();
      const subject = message.getSubject() || "(No Subject)";

      if (actionName === "delete") {
        message.moveToTrash();

        UrlFetchApp.fetch(payload.response_url, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            text: `🗑️ Deleted email from *${from}*\n📌 *Subject:* ${subject}`,
            replace_original: true
          })
        });

      } else if (actionName === "ignore_email") {

        UrlFetchApp.fetch(payload.response_url, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            text: `🚫 Ignored email from *${from}*\n📌 *Subject:* ${subject}`,
            replace_original: true
          })
        });
      } else {
        UrlFetchApp.fetch(payload.response_url, {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({
            text: `⚠️ Unknown action: ${actionName}`,
            replace_original: false
          })
        });
      }

      return response;
    }

    // Handle slash command: /reply
    if (params.command === "/reply") {
      const [messageId, ...replyParts] = params.text.trim().split(" ");
      const replyText = replyParts.join(" ");

      if (!messageId || !replyText) {
        return ContentService.createTextOutput("Usage: /reply <messageId> <your reply>");
      }

      const msg = GmailApp.getMessageById(messageId);
      msg.getThread().reply(replyText);

      return ContentService.createTextOutput(`✅ Replied to email from ${msg.getFrom()}`);
    }

    return ContentService.createTextOutput("No matching handler");

  } catch (error) {
    Logger.log("Error in doPost: " + error);
    return ContentService.createTextOutput("❌ Error: " + error.message);
  }
}

function doGet(e) {
  if (e.parameter.code) {
    const code = e.parameter.code;

    // Exchange code for access token
    const tokenResponse = UrlFetchApp.fetch("https://slack.com/api/oauth.v2.access", {
      method: "post",
      payload: {
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code: code,
        redirect_uri: REDIRECT_URI
      }
    });

    const result = JSON.parse(tokenResponse.getContentText());
    Logger.log(result);

    if (!result.ok) {
      return HtmlService.createHtmlOutput(`<h3>❌ Slack authorization failed:</h3><pre>${JSON.stringify(result, null, 2)}</pre>`);
    }

    // Store the token and team info
    const teamId = result.team.id;
    const botToken = result.access_token;
    const webhookUrl = result.incoming_webhook?.url;
    const userToken = result.authed_user?.access_token;
    const userId = result.authed_user?.id || "unknown";

    // Store using PropertiesService or Firebase, etc.
    const props = PropertiesService.getScriptProperties();
    props.setProperty(`slack_token_${getUserEmail()}`, botToken);
    props.setProperty(`slack_user_${getUserEmail()}`, userId);
    props.setProperty(`slack_webhook_${getUserEmail()}`, webhookUrl);

    setupTrigger();

    return HtmlService.createHtmlOutput(`
      <h2>✅ Slack connected!</h2>
      <p>App has been authorized for workspace: <b>${result.team.name}</b></p>
      <p>You can now close this window.</p>
    `);
  }

  return doGet1();
}


function doGet1(e) {
  return HtmlService.createHtmlOutputFromFile("SlackConfigUI")
  .setTitle("Slack Webhook Config");
}

function getUserEmail() {
  return Session.getActiveUser().getEmail();
}

function getSlackWebhook() {
  const email = Session.getActiveUser().getEmail();
  if (!email) {
    throw new Error("Cannot determine user identity.");
  }

  Logger.log("Getting webhook for user: " + email);
  const webhookUrl = PropertiesService.getScriptProperties().getProperty(`slack_webhook_${email}`);
  return webhookUrl;
}

function saveSlackWebhook(url) {
  if (!url || !url.startsWith("https://hooks.slack.com/")) {
    throw new Error("Invalid Slack webhook URL.");
  }

  const email = Session.getActiveUser().getEmail();
  if (!email) {
    throw new Error("Cannot determine user identity.");
  }

  Logger.log("Saving webhook for user: " + email);
  PropertiesService.getScriptProperties().setProperty(`slack_webhook_${email}`, url);
}

function setupTrigger() {
  let existing = ScriptApp.getProjectTriggers().some(
    t => t.getHandlerFunction() === "sendNewEmailsToSlack"
  );

  if (!existing){
    ScriptApp.newTrigger("sendNewEmailsToSlack")
      .timeBased()
      .everyMinutes(15)
      .create();
  }

  existing = ScriptApp.getProjectTriggers().some(
    t => t.getHandlerFunction() === "pollFirebaseQueue"
  );

  if (existing) return "✅ Trigger already set up.";

  ScriptApp.newTrigger("pollFirebaseQueue")
    .timeBased()
    .everyMinutes(15)
    .create();

  return "✅ Trigger created to check emails every 15 minutes.";
}

/**
 * Poll Firebase queue and process each message.
 */
function pollFirebaseQueue() {
  try {
    const userEmail = getUserEmail();
    const data= readQueue(userEmail);

    if (!data) {
      Logger.log("✅ No items in queue.");
      return;
    }

    // Iterate through each queue item
    for (const [key, item] of Object.entries(data)) {
      Logger.log(`🔄 Processing queue item: ${key}`);

      const { email, messageId, action } = item;
      if(email === userEmail){
        if (!messageId || !action) {
          Logger.log(`⚠️ Skipping invalid item: ${JSON.stringify(item)}`);
          deleteQueueItem(userEmail, key);
          continue;
        }

        // Example processing
        if (action === "delete") {
          try {
            const message = GmailApp.getMessageById(messageId);
            message.moveToTrash();
            Logger.log(`🗑️ Deleted email: ${message.getSubject()} from ${message.getFrom()}`);
          } catch (err) {
            Logger.log(`❌ Failed to delete email ${messageId}: ${err.message}`);
          }
        } else if (action === "ignore") {
          try {
            Logger.log(`🚫 Marked email as read: ${message.getSubject()}`);
          } catch (err) {
            Logger.log(`❌ Failed to mark email ${messageId} as read: ${err.message}`);
          }
        }

        // Remove from queue after processing
        deleteQueueItem(userEmail, key);
      }
    }
  } catch (err) {
    Logger.log(`❌ Error fetching queue: ${err.message}`);
  }
}