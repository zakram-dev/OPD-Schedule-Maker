# OPD Schedule Maker — production image
# Stage 1: build the site and bundle the reading libraries
FROM alpine:3.20 AS build
RUN apk add --no-cache curl
WORKDIR /src
COPY index.html favicon-ogp-48x48.png ./
COPY css ./css
COPY js ./js
COPY fonts ./fonts
COPY deploy/build-site.sh ./deploy/build-site.sh
RUN sh deploy/build-site.sh /site

# Stage 2: tiny web server
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
