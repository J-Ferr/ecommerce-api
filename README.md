# E-commerce REST API (Node + Express + PostgreSQL)
Production-Style API with JWT auth, product catalog (search/filters/pagination), carts, and transactional checkout into orders. Documented via OpenAPI/Swagger; deployed on Render; covered by Jest tests.

![CI](https://github.com/J-Ferr/ecommerce-api/actions/workflows/ci.yml/badge.svg)

## Demo
- Live API: https://ecommerce-api-pj4v.onrender.com
- Docs (Swagger): https://ecommerce-api-pj4v.onrender.com/docs
- Code: https://github.com/J-Ferr/ecommerce-api.git

## Highlights
- JWT auth (register, login, `/users/me`)
- Products CRUD with **search, price filters, pagination**
- Carts & Orders with **transactional checkout**
- OpenAPI docs, Jest tests, Render deploy, PostgreSQL

## Stack 
Node 20 - Express - pd - bcryptjs - jsonwebtoken - swagger-ui-express - Jest +Supertest - Render (web + PostgreSQL)

## Quickstart (local)
``bash
cp .env.example .env   # fill DATABASE_URL + JWT_SECRET
npm install
npm run dev            # https://localhost:3000/health

