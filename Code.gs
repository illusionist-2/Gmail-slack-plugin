const SLACK_WEBHOOK_URL = "{SLACK_WEBHOOK_URL}"

function sendNewEmailsToSlack() {
  const threads = GmailApp.search("is:inbox is:unread", 0, 10); // Only top 10 unread threads
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24*60 * 60 * 1000); // 24 hours ago

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


      const payload = {
        text: "━━━━━━━━━━━━ 📧 *New Email* ━━━━━━━━━━━━",
        attachments: [
          {
            callback_id: "email_actions", 
            color: "#36a64f",
            fields: [
              {
                title: "From",
                value: sender,
                short: true
              },
              {
                title: "Subject",
                value: subject || "(No Subject)",
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
                value: messageId,
                action_id: "ignore_email",
                name: "ignore_email"
              },
              {
                type: "button",
                text: "🗑️ Delete",
                style: "danger",
                value: messageId,
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

      UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload)
      });

      message.markRead(); // ✅ Mark processed message as read to avoid resending
    }
  }
}

function doGet(e) {
  return HtmlService.createHtmlOutput("⚙️ This endpoint is active. Use POST (Slack actions).");
}

function doPost(e) {
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