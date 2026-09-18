# Pluto persisted-mapping smoke test

This optional local procedure inserts one explicit movie mapping and exercises the existing
stream API. It never discovers or searches the Pluto catalog at runtime.

1. Create a temporary JSON file outside the repository, replacing every placeholder:

   ```json
   {
     "movie": "PROVIDER_TITLE",
     "year": 2020,
     "pluto_id": "24_HEX_CHARACTER_PLUTO_ID",
     "tmdb_id": 12345,
     "match": "manual"
   }
   ```

2. Preview and then apply it to the configured local/test PostgreSQL database:

   ```powershell
   npm run provider-mappings:import -- --provider pluto --region latam --file C:\temp\pluto-mapping.json
   npm run provider-mappings:import -- --provider pluto --region latam --file C:\temp\pluto-mapping.json --apply
   ```

3. Set `PLUTO_ENABLED=true`, `PLUTO_REGION=latam`, and enable the existing Resolver V2 primary
   path according to the current rollout settings. Start the API and stream worker normally.

4. With an access token and the Kanchita movie UUID corresponding to the mapped TMDB movie:

   ```powershell
   curl.exe -H "Authorization: Bearer ACCESS_TOKEN" http://localhost:3000/api/streams/movie/MOVIE_UUID
   ```

The first response may be `202`; repeat after `Retry-After`. A mapping miss returns through the
normal no-source/fallback behavior. Do not commit the temporary JSON file or any access token.
