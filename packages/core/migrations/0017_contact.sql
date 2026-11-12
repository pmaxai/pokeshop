-- Contact form: messages land in the admin (Admin › Nachrichten). The table exists since 0004;
-- now it keeps whether a message was read and handled, and the proof-of-work challenge it
-- solved, so one solved challenge cannot send twice.
ALTER TABLE contact_messages
  ADD COLUMN read_at timestamptz,
  ADD COLUMN done_at timestamptz,
  ADD COLUMN done_by text,
  ADD COLUMN challenge text UNIQUE,
  ADD CONSTRAINT contact_messages_name_check CHECK (length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT contact_messages_message_check CHECK (length(message) BETWEEN 1 AND 5000);
CREATE INDEX contact_messages_open ON contact_messages (created_at DESC) WHERE done_at IS NULL;

-- E-mail to the admin alert recipients on every new message (switch in Admin › Nachrichten).
INSERT INTO settings (key, value) VALUES ('contact_notify', 'true') ON CONFLICT (key) DO NOTHING;
