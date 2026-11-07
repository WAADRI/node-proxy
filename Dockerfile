# node-proxy-go server: panel built in a node stage, Go binary on top -
# the runtime image is a static binary + certs on a minimal base.
FROM node:22-alpine AS panel
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY panel/ ./
RUN npm run build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=panel /panel/dist ./panel/dist
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -o /out/node-proxy-server ./cmd/node-proxy-server

FROM alpine:3.20
RUN adduser -D -H nodeproxy
COPY --from=build /out/node-proxy-server /usr/local/bin/node-proxy-server
USER nodeproxy
EXPOSE 3000 8080 1080
ENTRYPOINT ["node-proxy-server"]
