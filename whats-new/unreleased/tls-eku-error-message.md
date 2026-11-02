---
title: Clearer error for a certificate with the wrong usage
kind: fix
area: app
highlight: false
---
On macOS, a connection refused because the server's certificate is not meant for TLS servers
now says **certificate had invalid extended key usage** instead of a raw OS error code.
