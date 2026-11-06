# Cloudflare in front of the edge (ADR-0023)

Production runs behind Cloudflare, which tells the platform where a request
comes from. The edge proxy trusts that location **only** for connections that
come from Cloudflare's networks.

## Cloudflare settings

1. **DNS:** proxy the site's records through Cloudflare (orange cloud). The
   origin must not be reachable directly. Allow inbound traffic to the edge
   only from Cloudflare's ranges (firewall or security group), and
   preferably use Authenticated Origin Pulls (mTLS) as well.
2. **Location headers:** turn on the Managed Transform **"Add visitor location
   headers"**. It adds `CF-Region-Code`, which the platform needs for
   sub-national restrictions such as Ontario. `CF-IPCountry` is sent by
   default.
3. **SSL/TLS:** use **Full (strict)** mode, with an origin certificate on the
   edge.
4. **Optional:** add a WAF rule that shows a block page for restricted
   countries on the web app's pages. **Never** block `/api/*` paths with it:
   users in restricted regions must still be able to close positions and
   withdraw (ADR-0022).

## Platform settings

```
GEO_COUNTRY_HEADER=x-edge-country
GEO_REGION_HEADER=x-edge-region
GEO_UNKNOWN_COUNTRY=deny
RESTRICTED_COUNTRIES=...        # counsel decision (preset in .env.example)
RESTRICTED_SUBDIVISIONS=...     # counsel decision
SANCTIONS_SYNC_HOURS=24
```

## Keeping Cloudflare's ranges current

Cloudflare publishes its networks at https://www.cloudflare.com/ips. To
update the edge's copy:

1. Run `scripts/update-cloudflare-ips.sh`.
2. Review and commit the change.
3. Restart `edge`.

Do this monthly, or when Cloudflare announces a change. If a new Cloudflare
range is missing, visitors arriving through it are treated as unknown
location, and with `GEO_UNKNOWN_COUNTRY=deny` they cannot open new risk. This
fails safe, but it is visible to users.

## Checking it

To check what the platform sees, run `curl https://<site>/api/v1/access`. It
returns your country, your subdivision and whether your region is restricted.

From a server that is not Cloudflare, call the origin directly (bypassing
Cloudflare). It must show `"country": null`.
