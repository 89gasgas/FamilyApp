#!/bin/sh
# Prints only HTTP status codes; never prints key values.
F="C:/Users/gabri/Desktop/FamilyApp/Segreti.txt"
get() { grep -E "^[[:space:]]*$1[[:space:]]*[=:]" "$F" | head -1 | sed -E 's/^[^=:]*[=:][[:space:]]*//; s/[[:space:]]*$//; s/\r$//; s/^"//; s/"$//'; }
GT=$(get GITHUB_TOKEN); SA=$(get SUPABASE_ACCESS_TOKEN); VT=$(get VERCEL_TOKEN)
SU=$(get SUPABASE_URL); SK=$(get SUPABASE_ANON_KEY); GU=$(get GITHUB_USER)
for v in GT SA VT SU SK GU; do eval "x=\$$v"; [ -n "$x" ] && echo "$v: presente" || echo "$v: MANCANTE"; done
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$@"; }
echo "GitHub utente:        $(code -H "Authorization: Bearer $GT" https://api.github.com/user)"
echo "GitHub repo FamilyApp: $(code -H "Authorization: Bearer $GT" "https://api.github.com/repos/$GU/FamilyApp")"
echo "Supabase management:  $(code -H "Authorization: Bearer $SA" https://api.supabase.com/v1/projects)"
echo "Supabase progetto:    $(code -H "apikey: $SK" -H "Authorization: Bearer $SK" "$SU/rest/v1/")"
echo "Supabase auth health: $(code -H "apikey: $SK" "$SU/auth/v1/health")"
echo "Vercel utente:        $(code -H "Authorization: Bearer $VT" https://api.vercel.com/v2/user)"
