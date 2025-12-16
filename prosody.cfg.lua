-- Prosody Configuration for Agent Chat Service
-- This configuration is designed for containerized deployment

-- General settings
pidfile = "/var/run/prosody/prosody.pid"
admins = { }

-- Network interfaces to listen on
interfaces = { "*" }

-- Modules to load
modules_enabled = {
    -- Core modules
    "roster";
    "saslauth";
    "tls";
    "dialback";
    "disco";
    "posix";
    "ping";

    -- Chat features
    "carbons";
    "blocklist";
    "vcard4";
    "vcard_legacy";

    -- Admin
    "admin_rest";

    -- Message handling
    "offline";
    "stream_management";
}

modules_disabled = {
    "s2s";  -- Disable server-to-server (not needed for local use)
}

-- Disable server-to-server connections
s2s_require_encryption = false

-- Allow unencrypted client connections (for local container use)
-- In production, you should enable TLS
c2s_require_encryption = false

-- Authentication
authentication = "internal_hashed"

-- Storage
storage = "internal"
data_path = "/var/lib/prosody"

-- Logging
log = {
    info = "*console";
    warn = "*console";
    error = "*console";
}

-- HTTP server for admin_rest
http_ports = { 5280 }
http_interfaces = { "*" }
http_default_host = "localhost"

-- Admin REST configuration
-- Note: In production, secure this properly
admin_rest_enabled = true

-- Virtual host configuration
-- The domain will be configured via environment variable in entrypoint
VirtualHost "localhost"
    enabled = true

    -- Allow registration (for creating agent users)
    allow_registration = false

    -- Modules specific to this host
    modules_enabled = {
        "admin_rest";
    }

-- Component for admin interface
Component "admin.localhost" "admin_web"
