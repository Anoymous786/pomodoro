````markdown
# 🍅 Pomodoro Dashboard (currently paused due to AWS credits, service will start soon)

**Pomodoro Dashboard** is an AI-powered productivity and learning platform that combines a Pomodoro focus timer, task management, adaptive learning roadmaps, assessments, progress tracking, skill profiles, resume-based planning, and a grounded AI Study Assistant.

The application is built with **Next.js 14 + TypeScript**, containerized with **Docker**, and deployed on **Amazon ECS/Fargate behind an Application Load Balancer (ALB)**.

The repository also contains a serverless AWS backend using **API Gateway, Lambda, DynamoDB, S3, SQS and SNS**.

---

## 🚀 Live Demo (currently paused due to AWS credits, service will start soon)

### Application (currently paused due to AWS credits, service will start soon)

http://pomodoro-dashboard-alb-1223371936.us-east-1.elb.amazonaws.com       (currently paused due to AWS credits, service will start soon)

> ⚠️ The current demo is served over HTTP. HTTPS/custom domain is planned for a future deployment phase.

---

# ✨ Features

## Productivity

- 🍅 Pomodoro focus timer
- ✅ Task creation and management
- 🎯 Task priorities and time estimates
- ⏱️ Focus-session tracking
- 📊 Daily progress tracking
- 🔥 Streaks and activity heatmap
- 📈 Productivity analytics

## AI Learning

- 🤖 AI-generated learning roadmaps
- 📅 1 / 3 / 7-day learning plans
- 🎯 Adaptive AI intake based on:
  - Learning goal
  - Current skill level
  - Available time
  - Deadline
  - Constraints
  - Optional resume
- 🔄 Automatic daily re-planning
- 📝 AI-generated quick checks
- 🧠 Task-level quizzes
- 📚 End-of-day assessments
- 🎓 Roadmap-level mock exams
- 📈 Persistent skill profiles

## AI Study Assistant

The Study Assistant provides answers based on the user's actual tracked learning data.

It can use:

- Tasks
- Roadmaps
- Completed learning steps
- Assessment scores
- Focus sessions
- Learning progress

The assistant rebuilds the learning context from server-side data rather than relying only on client-side state.

## Resume-Based Planning

Users can upload:

- PDF
- DOCX
- TXT
- Markdown
- CSV

Files are uploaded directly to **Amazon S3 using pre-signed URLs**.

A Lambda function extracts the content and makes it available to the AI planning workflow.

---

# 🏗️ Architecture

The project follows a **hybrid AWS architecture**.

```mermaid
flowchart LR

    User["User / Browser"]

    User --> ALB["Application Load Balancer"]

    ALB --> ECS["ECS / Fargate"]

    ECS --> App["Dockerized Next.js App"]

    App --> API["API Gateway"]

    API --> Lambda["AWS Lambda"]

    Lambda --> DDB["DynamoDB"]

    Lambda --> S3["Amazon S3"]

    Lambda --> SQS["Amazon SQS"]

    SQS --> Worker["Roadmap Worker Lambda"]

    Worker --> LLM["Groq / Gemini"]

    Worker --> DDB

    Worker --> SNS["Amazon SNS"]

    ECS --> Redis["ElastiCache Redis"]

    ECS --> CW["CloudWatch"]

    Lambda --> CW
````

### Main Application Flow

```text
User
  ↓
Application Load Balancer
  ↓
ECS / Fargate
  ↓
Dockerized Next.js Application
  ↓
AWS Backend Services
```

### Asynchronous AI Roadmap Flow

```text
API Request
    ↓
API Gateway
    ↓
Lambda
    ↓
SQS Queue
    ↓
Roadmap Worker Lambda
    ↓
LLM
    ↓
DynamoDB
    ↓
SNS Event
```

Long-running AI generation is therefore handled asynchronously instead of keeping the initial HTTP request open.

---

# ☁️ AWS Services

| AWS Service                   | Purpose                                       |
| ----------------------------- | --------------------------------------------- |
| **Amazon ECS / Fargate**      | Runs the containerized Next.js application    |
| **Application Load Balancer** | Public entry point for the application        |
| **Amazon ECR**                | Stores Docker images                          |
| **AWS Lambda**                | Serverless backend and AI processing          |
| **API Gateway**               | HTTP API for Lambda functions                 |
| **DynamoDB**                  | Stores roadmaps, progress, tasks and AI cache |
| **Amazon S3**                 | Private resume/file storage                   |
| **Amazon SQS**                | Asynchronous AI job processing                |
| **Amazon SNS**                | Application events and notifications          |
| **ElastiCache Redis**         | Redis caching layer                           |
| **IAM**                       | Access control and least-privilege roles      |
| **SSM Parameter Store**       | Secure LLM configuration/secrets              |
| **CloudWatch**                | Logs, metrics, alarms and dashboard           |
| **VPC**                       | Network isolation for ECS resources           |

---

# 🧰 Tech Stack

## Frontend

* Next.js 14
* React
* TypeScript
* Tailwind CSS
* Progressive Web App (PWA)

## Backend

* Next.js API Routes
* AWS Lambda
* API Gateway
* Node.js 20

## Database & Storage

* Amazon DynamoDB
* Amazon S3
* Amazon ElastiCache Redis

## AI

* Groq
* Google Gemini
* RAG-style grounded Study Assistant
* Structured JSON validation
* AI-generated roadmaps and assessments

## AWS / Infrastructure

* Amazon ECS
* AWS Fargate
* Application Load Balancer
* Amazon ECR
* AWS Lambda
* API Gateway
* DynamoDB
* S3
* SQS
* SNS
* ElastiCache Redis
* IAM
* SSM Parameter Store
* CloudWatch
* VPC

## Infrastructure as Code

* Terraform
* Docker

---

# 🐳 Docker

The application uses a production multi-stage Docker build.

### Build

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_BASE_URL=<API_GATEWAY_URL> \
  -t pomodoro-dashboard .
```

### Run

```bash
docker run -p 3000:3000 pomodoro-dashboard
```

The production image:

* Uses Node.js 20
* Uses Next.js standalone output
* Runs as a non-root user
* Exposes port `3000`
* Includes an application health check
* Is stored in Amazon ECR for ECS deployment

---

# 💻 Local Development

## Requirements

* Node.js 20+
* npm
* Docker (optional)

## Installation

```bash
npm install
```

Create the environment file:

```bash
cp .env.local.example .env.local
```

Add the required LLM configuration to `.env.local`.

Start the development server:

```bash
npm run dev
```

The application will be available at:

```text
http://localhost:3000
```

---

# 🔐 Security

The project implements several AWS security practices:

* IAM least-privilege roles
* Separate ECS execution and task roles
* SSM SecureString for LLM API keys
* Private S3 bucket
* S3 public-access blocking
* Redis restricted using security groups
* Non-root Docker container
* ECS security groups
* API input validation
* Secrets excluded from Git
* `.env.local` excluded from the Docker image

---

# 📊 Monitoring

AWS CloudWatch is used for application observability.

Current monitoring includes:

* ECS application logs
* Lambda logs
* API Gateway access logs
* Redis slow logs
* SQS queue monitoring
* Lambda error alarms
* DLQ alarms
* API 5XX alarms
* CloudWatch dashboard

The ECS application uses:

```text
/pomodoro/ecs/app
```

for container logs.

---

# 🧪 Testing

The repository contains verification scripts for major application flows.

Examples include:

```bash
npm run lint
npm run build
```

UI and workflow verification scripts are available under:

```text
scripts/
```

Examples:

```bash
node scripts/verify-load.mjs
node scripts/verify-ui.mjs
node scripts/verify-task-timer.mjs
node scripts/verify-task-roadmap.mjs
node scripts/verify-exam-chat.mjs
node scripts/verify-progress-sync.mjs
```

Application health can be checked with:

```bash
curl http://localhost:3000/api/health
```

---

# 📂 Project Structure

```text
pomodoro-dashboard/
│
├── app/
│   ├── (main)/
│   ├── api/
│   └── architecture/
│
├── components/
│
├── hooks/
│
├── lib/
│   ├── llm.ts
│   ├── ai.ts
│   ├── api.ts
│   ├── monitoring.ts
│   ├── skills.ts
│   ├── insights.ts
│   └── progress-sync.ts
│
├── public/
│
├── scripts/
│
├── infrastructure/
│   ├── terraform/
│   ├── lambda-src/
│   ├── scripts/
│   └── test-payloads/
│
├── Dockerfile
├── compose.yaml
├── next.config.mjs
├── package.json
├── tsconfig.json
└── README.md
```

---

# 🚀 AWS Deployment

AWS infrastructure is managed using Terraform.

The infrastructure includes:

```text
Terraform
   │
   ├── VPC
   ├── ECS / Fargate
   ├── ALB
   ├── ECR
   ├── Lambda
   ├── API Gateway
   ├── DynamoDB
   ├── S3
   ├── SQS
   ├── SNS
   ├── Redis
   ├── IAM
   ├── SSM
   └── CloudWatch
```

Infrastructure code is located in:

```text
infrastructure/terraform/
```

Basic deployment flow:

```bash
cd infrastructure/terraform

terraform init
terraform apply
```

The Docker image can then be built and pushed to Amazon ECR.

The ECS service pulls the image from ECR and runs it using Fargate.

---

# 🔄 AI Architecture

AI functionality is routed through a common LLM provider layer.

```text
Application
     ↓
LLM Provider Layer
     ↓
Groq
     │
     └── fallback → Gemini
```

AI responses are validated as structured JSON before being used by the application.

The platform uses AI for:

* Learning roadmap generation
* Adaptive planning
* Quick checks
* Quizzes
* Assessments
* Mock exams
* Study assistance
* Resume-based planning

---

# 📦 Background Processing

Long-running roadmap generation uses an asynchronous architecture:

```text
Client
  ↓
API Gateway
  ↓
Lambda
  ↓
SQS
  ↓
Roadmap Worker
  ↓
LLM
  ↓
DynamoDB
  ↓
SNS
```

This provides:

* Asynchronous processing
* Retry handling
* Dead-letter queue
* Failure isolation
* Better scalability

---

# 💰 AWS Cost

The current AWS deployment uses AWS credits.

The main resources that can generate continuous charges are:

* ECS/Fargate
* Application Load Balancer
* ElastiCache Redis

For cost control, resources can be scaled down when the demo is not required.

The serverless backend is designed for low-volume/demo usage.

> Always monitor AWS Billing and Cost Explorer when running the deployment.

---

# ⚠️ Current Limitations

* **OpenSearch is not currently implemented.** Roadmap search currently uses DynamoDB-based search.
* The live demo currently uses **HTTP instead of HTTPS**.
* Authentication is not implemented; the demo uses a single demo user.
* There is no CI/CD pipeline yet.
* AI reliability depends on external LLM providers.
* PDF extraction works best with PDFs containing a text layer.

---

# 🔮 Future Improvements

Planned improvements include:

* 🔎 OpenSearch for relevance-ranked search
* 🔒 HTTPS + custom domain
* 👤 Authentication using Cognito/OIDC
* ⚙️ CI/CD pipeline
* 🧪 Automated unit and integration tests
* 📊 Advanced AI observability
* 👥 Multi-user production architecture

---

# 🎯 Interview Architecture Summary

The architecture can be explained in a few steps:

### 1. Application Layer

The user accesses the application through the public Application Load Balancer.

### 2. Container Layer

The ALB forwards requests to a Dockerized Next.js application running on ECS/Fargate.

### 3. Backend Layer

AWS API Gateway and Lambda provide backend APIs and serverless processing.

### 4. Async Processing

Long-running AI roadmap generation is decoupled using:

```text
SQS → Worker Lambda → LLM → DynamoDB → SNS
```

### 5. Storage & Infrastructure

The application uses:

```text
DynamoDB → Application state
S3       → Resume/file storage
Redis    → Caching
SNS      → Events
CloudWatch → Monitoring
IAM      → Security
SSM      → Secrets
```

This hybrid architecture allows the application container and serverless AWS services to work together while keeping long-running AI workloads asynchronous.

---

# 🌟 Why This Project?

The project demonstrates practical experience with:

* Full-stack development
* AI/LLM integration
* RAG-style applications
* Docker containerization
* AWS ECS/Fargate
* Serverless architecture
* Asynchronous processing
* AWS networking
* IAM security
* Redis caching
* CloudWatch monitoring
* Terraform infrastructure
* Production-oriented deployment

---

## 👨‍💻 Author

Built as an AWS-focused AI productivity and learning platform using:

**Next.js + TypeScript + Docker + ECS/Fargate + Lambda + API Gateway + DynamoDB + S3 + SQS + SNS + Redis + IAM + CloudWatch + Terraform + LLMs**

```
