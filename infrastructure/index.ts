import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as path from "path";
import { marshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";

const config = new pulumi.Config();
// Read the domain configuration
const domainName = config.require("domainName"); // e.g., api.yourdomain.com
const rootDomain = config.require("rootDomain"); // e.g., yourdomain.com

// 1. Create an ECR repository to store our Docker image.
const repo = new awsx.ecr.Repository("diversitus-repo", {
    forceDelete: true, // Useful for development, consider removing for production
});

// 2. Build and publish the Docker image to the ECR repository.
const image = new awsx.ecr.Image("diversitus-image", {
    repositoryUrl: repo.url,
    context: path.join(__dirname, ".."),
    dockerfile: path.join(__dirname, "..", "backend", "app", "Dockerfile"),
    // Add platform specification for consistency
    platform: "linux/amd64",
});

// 3. Create a DynamoDB table to store job listings.
const jobsTable = new aws.dynamodb.Table("diversitus-jobs-table", {
    attributes: [
        { name: "id", type: "S" },
    ],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST",
    tags: {
        Project: "Diversitus",
    },
});

// 3b. Create a DynamoDB table to store company data.
const companiesTable = new aws.dynamodb.Table("diversitus-companies-table", {
    attributes: [{ name: "id", type: "S" }],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST",
    tags: { Project: "Diversitus" },
});

// 3c. Create a DynamoDB table to store user data.
const usersTable = new aws.dynamodb.Table("diversitus-users-table", {
    attributes: [
        { name: "id", type: "S" },
        { name: "email", type: "S" },
    ],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST",
    globalSecondaryIndexes: [{
        name: "EmailIndex",
        hashKey: "email",
        projectionType: "ALL",
    }],
    tags: { Project: "Diversitus" },
});

// Seed the companies table with initial data.
const companies = [
    { id: uuidv4(), name: "Creative Co.", traits: { "work_life_balance": 9, "collaboration": 8, "working_from_home": 10 } },
    { id: uuidv4(), name: "Logic Inc.", traits: { "deep_focus": 9, "autonomy": 7, "quiet_office": 9, "working_from_home": 8 } },
    { id: uuidv4(), name: "DataDriven Corp", traits: { "pattern_recognition": 9, "deep_focus": 8, "quiet_office": 7 } },
];

companies.forEach((company, i) => {
    new aws.dynamodb.TableItem(`company-item-${i}`, {
        tableName: companiesTable.name,
        hashKey: companiesTable.hashKey,
        item: JSON.stringify(marshall(company)),
    });
});

// Seed the jobs table with updated data linking to companies.
const initialJobsData = [
    { id: uuidv4(), companyId: companies[0].id, title: "Frontend Developer", description: "Build beautiful and accessible user interfaces.", traits: { "attention_to_detail": 8, "visual_thinking": 9, "working_from_home": 9 } },
    { id: uuidv4(), companyId: companies[1].id, title: "Backend Engineer", description: "Design and implement scalable server-side logic.", traits: { "problem_solving": 9, "systematic_thinking": 8, "quiet_office": 8 } },
    { id: uuidv4(), companyId: companies[0].id, title: "UX Designer", description: "Create intuitive and user-friendly application flows.", traits: { "empathy": 9, "visual_thinking": 10, "working_from_home": 10 } },
    { id: uuidv4(), companyId: companies[2].id, title: "Data Analyst", description: "Find insights and patterns in large datasets.", traits: { "pattern_recognition": 10, "attention_to_detail": 9, "quiet_office": 7 } },
    { id: uuidv4(), companyId: companies[1].id, title: "DevOps Engineer", description: "Automate and streamline our infrastructure and deployment pipelines.", traits: { "systematic_thinking": 9, "problem_solving": 8, "working_from_home": 7 } },
];

initialJobsData.forEach((job, i) => {
    new aws.dynamodb.TableItem(`job-item-${i}`, {
        tableName: jobsTable.name,
        hashKey: jobsTable.hashKey,
        item: JSON.stringify(marshall(job)),
    });
});

// 4. Create an IAM role for the Fargate Task.
const taskRole = new aws.iam.Role("diversitus-task-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs-tasks.amazonaws.com" }),
});

// 5. Create and attach an inline policy to the role, allowing it to access DynamoDB.
new aws.iam.RolePolicy("diversitus-db-access-policy", {
    role: taskRole.id,
    policy: pulumi.all([jobsTable.arn, companiesTable.arn, usersTable.arn]).apply(([jobsArn, companiesArn, usersArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem"],
            Effect: "Allow",
            Resource: [jobsArn, companiesArn, usersArn, `${usersArn}/index/EmailIndex`],
        }],
    })),
});

// 6. Create a new Route 53 hosted zone for the root domain.
// IMPORTANT: After the zone is created, you must go to your domain registrar
// and update the name servers for your domain to the ones assigned by AWS.
// These will be available in the Pulumi stack outputs.
const hostedZone = new aws.route53.Zone("diversitus-zone", {
    name: rootDomain,
    // This creates a public hosted zone. For a private zone, you would need to
    // associate it with a VPC, e.g., `vpcs: [{ vpcId: myVpc.id }]`
});

// 7. Provision a new ACM certificate for your domain.
const certificate = new aws.acm.Certificate("cert", {
    domainName: domainName,
    validationMethod: "DNS",
});

// 8. Create the DNS record to validate the ACM certificate.
const certificateValidation = new aws.route53.Record(`${domainName}-validation`, {
    name: certificate.domainValidationOptions[0].resourceRecordName,
    type: certificate.domainValidationOptions[0].resourceRecordType,
    records: [certificate.domainValidationOptions[0].resourceRecordValue],
    zoneId: hostedZone.zoneId,
    ttl: 300,
});

// 9. Create a CertificateValidation resource to wait for the validation to complete.
const validatedCertificate = new aws.acm.CertificateValidation("certValidation", {
    certificateArn: certificate.arn,
    validationRecordFqdns: [certificateValidation.fqdn],
});

// 10. Create an ECS Cluster, Load Balancer, and the Fargate Service.
const cluster = new aws.ecs.Cluster("diversitus-cluster");
const alb = new awsx.lb.ApplicationLoadBalancer("diversitus-lb", {
    // Configure the default target group to expect targets on port 8080, matching the Ktor application.
    defaultTargetGroup: {
        port: 8080,
        protocol: "HTTP", // Traffic between ALB and Fargate is unencrypted and thus cheaper.
    },
    // Override the default listener to use HTTPS on port 443 with our validated certificate.
    listener: {
        port: 443,
        protocol: "HTTPS",
        certificateArn: validatedCertificate.certificateArn,
    },
});
const service = new awsx.ecs.FargateService("diversitus-fargate-service", {
    cluster: cluster.arn,
    // The task definition is defined inline.
    taskDefinitionArgs: {
        // Pass the ARN of the role we created explicitly.
        taskRole: { roleArn: taskRole.arn },
        // Define the container to run.
        container: {
            name: "app", // A required name for the container within the task definition.
            image: image.imageUri,
            cpu: 256,
            memory: 512,
            // Map the container's port to the load balancer's target group.
            portMappings: [{
                containerPort: 8080, // The port Ktor listens on inside the container.
                // For awsvpc network mode, hostPort must be specified and must match containerPort.
                hostPort: 8080,
                targetGroup: alb.defaultTargetGroup,
            }],
            environment: [
                { name: "JOBS_TABLE_NAME", value: jobsTable.name },
                { name: "COMPANIES_TABLE_NAME", value: companiesTable.name },
                { name: "USERS_TABLE_NAME", value: usersTable.name },
                { name: "AWS_REGION", value: aws.getRegion().then(r => r.name) },
            ],
        },
    },
    desiredCount: 1, // Run one instance of our container
    // By default, Fargate services are placed in private subnets. The default VPC
    // often lacks private subnets, causing an error. Setting assignPublicIp to true
    // ensures the service is placed in public subnets and can be reached by the ALB.
    assignPublicIp: true,
});

// 11. Create a Route 53 Alias record to point your custom domain to the ALB.
new aws.route53.Record(domainName, {
    name: domainName,
    type: "A",
    zoneId: hostedZone.zoneId,
    aliases: [{
        name: alb.loadBalancer.dnsName,
        zoneId: alb.loadBalancer.zoneId,
        evaluateTargetHealth: true,
    }],
});

// 12. Export the secure, custom URL of your service.
export const url = pulumi.interpolate`https://${domainName}`;

// Export the name servers for the hosted zone so you can update your registrar.
export const nameServers = hostedZone.nameServers;